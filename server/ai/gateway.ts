import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { agentEnvPrefix, chat, llmConfigFor, type ChatMessage, type ChatResult, type LlmConfig, type LlmUsage, type ToolSpec } from '../agents/llmClient.js';
import { getDb, nowIso, type Db } from '../db/index.js';
import { sha256Hex } from '../util/hash.js';

/**
 * The only way LexCompiler calls a language model. It picks the model from the workspace's AI
 * setting, refuses when AI is off or the day's token budget is used up, validates JSON answers
 * (with one correction turn), and logs every call without storing the prompt.
 */

export type AiMode = 'off' | 'local' | 'cloud';
export const AI_MODES: AiMode[] = ['off', 'local', 'cloud'];
export const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;
/** Cloud tokens per UTC day for all agents together, unless LEXCOMPILER_AGENT_MAX_DAILY_TOKENS says otherwise. */
export const DEFAULT_AGENT_DAILY_TOKENS = 100_000;
/** Largest answer one relayed agent call may ask for. */
const AGENT_MAX_OUTPUT_TOKENS = 4096;
const AGENT_DEFAULT_OUTPUT_TOKENS = 2048;

/** The agents' daily cloud-token budget is used up. */
export class AgentBudgetError extends Error {
  readonly status = 429;
  constructor(
    readonly used: number,
    readonly budget: number
  ) {
    super(`The agents' daily model budget is used up (${used.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens). It resets at 00:00 UTC; LEXCOMPILER_AGENT_MAX_DAILY_TOKENS sets it.`);
  }
}

/** A relayed agent call that cannot be served; `status` is the HTTP status for the agent. */
export class AgentRelayError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Fields of an OpenAI chat-completions request that are passed on to the agent's model. */
const RELAY_FIELDS = [
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'response_format',
  'max_tokens',
  'max_completion_tokens',
  'frequency_penalty',
  'presence_penalty',
] as const;

/**
 * The request sent to the agent's model: known fields only, the configured model, a capped
 * answer size, and JSON-schema output rewritten for providers without it (DeepSeek takes
 * json_object, so the schema goes into the system prompt instead).
 */
export function relayBody(body: Record<string, unknown>, cfg: LlmConfig): Record<string, unknown> {
  const wire: Record<string, unknown> = { model: cfg.model, stream: false };
  for (const k of RELAY_FIELDS) if (body[k] !== undefined && body[k] !== null) wire[k] = body[k];
  const sizeField = wire.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
  const asked = Number(wire[sizeField]);
  wire[sizeField] = Math.min(Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : AGENT_DEFAULT_OUTPUT_TOKENS, AGENT_MAX_OUTPUT_TOKENS);

  let messages = [...(wire.messages as Array<Record<string, unknown>>)];
  const format = wire.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined;
  if (format?.type === 'json_schema' && cfg.jsonMode !== 'schema') {
    const hasTools = Array.isArray(wire.tools) && wire.tools.length > 0;
    const schema = JSON.stringify(format.json_schema?.schema ?? {});
    const instruction = hasTools
      ? `When you have what you need from the tools, give your final answer as only one JSON object that matches this JSON Schema:\n${schema}`
      : `Reply with only one JSON object that matches this JSON Schema:\n${schema}`;
    // json_object mode makes the model write JSON instead of calling tools, so it is set only when there are none.
    if (cfg.jsonMode === 'object' && !hasTools) wire.response_format = { type: 'json_object' };
    else delete wire.response_format;
    const first = messages[0];
    messages =
      first?.role === 'system' && typeof first.content === 'string'
        ? [{ ...first, content: `${first.content}\n\n${instruction}` }, ...messages.slice(1)]
        : [{ role: 'system', content: instruction }, ...messages];
  }
  wire.messages = messages;
  // Strict tool schemas need json_schema support (DeepSeek offers them on its beta endpoint only).
  if (cfg.jsonMode !== 'schema' && Array.isArray(wire.tools)) {
    wire.tools = (wire.tools as Array<{ type?: string; function?: Record<string, unknown> }>).map((t) => {
      if (!t.function || !('strict' in t.function)) return t;
      const { strict: _strict, ...fn } = t.function;
      return { ...t, function: fn };
    });
  }
  return wire;
}

export interface WorkspaceAiSettings {
  mode: AiMode;
  dailyTokenBudget: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface CompleteRequest {
  /** null for the demo screens, which use the bundled fixture rather than customer data. */
  workspaceId: string | null;
  /** What the call is for (drafting, explanation, fix, rag-answer, …); also picks LEXCOMPILER_AGENT_<TASK>_* settings. */
  task: string;
  system?: string;
  prompt: string;
  /** JSON Schema for the answer. The answer is parsed, checked with `validate`, and corrected once if invalid. */
  schema?: Record<string, unknown>;
  validate?: (value: unknown) => string | null;
  maxTokens?: number;
  timeoutMs?: number;
  /** Demo screens only: choose local or cloud per request. Workspaces always use their own setting. */
  mode?: AiMode;
  /** Demo screens only: which local (Ollama) model to use. */
  localModel?: string;
}

export interface CompleteResult {
  ok: boolean;
  /** Set when no model ran: AI is off, no model is configured for the mode, or the daily budget is used up. */
  refused?: 'ai_off' | 'no_model' | 'budget';
  /** Set when the model answered, but not with valid JSON for the schema. */
  invalid?: string;
  /** Set when the call failed (network, HTTP error, timeout). */
  error?: string;
  text: string;
  json?: unknown;
  mode: AiMode;
  model: string;
  endpointHost: string;
  usage: LlmUsage;
  latencyMs: number;
}

export interface AiCallRecord {
  id: string;
  workspaceId: string | null;
  task: string;
  mode: AiMode;
  provider: string;
  model: string;
  endpointHost: string;
  promptSha256: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  outcome: 'ok' | 'invalid_output' | 'error';
  error: string | null;
  createdAt: string;
}

const EMPTY_USAGE = (): LlmUsage => ({ promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, cacheWriteTokens: 0 });

function isLocalHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local');
  } catch {
    return false;
  }
}

/** The local model (Ollama's OpenAI-compatible endpoint): LEXCOMPILER_LOCAL_LLM_MODEL, default qwen2.5-coder:0.5b. */
export function localModelConfig(model?: string, env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const m = model || env.LEXCOMPILER_LOCAL_LLM_MODEL || 'qwen2.5-coder:0.5b';
  return { provider: 'openai', model: m, baseUrl: `${host}/v1`, label: `${m} via ${new URL(host).host}` };
}

/**
 * The model a task uses in a mode: local → Ollama; cloud → LEXCOMPILER_AGENT_<TASK>_* or
 * LEXCOMPILER_LLM_*, else gpt-4o-mini when only OPENAI_API_KEY is set (older setups).
 */
export function modelForTask(task: string, mode: AiMode, options: { localModel?: string; env?: NodeJS.ProcessEnv } = {}): LlmConfig | null {
  const env = options.env ?? process.env;
  if (mode === 'off') return null;
  if (mode === 'local') return localModelConfig(options.localModel, env);
  const configured = llmConfigFor(task, env);
  if (configured) return configured;
  const key = env.OPENAI_API_KEY?.trim();
  return key ? { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKey: key, label: 'gpt-4o-mini via api.openai.com' } : null;
}

/** Finds the JSON object in a model answer (fenced or bare). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;

export class AiGateway {
  constructor(
    private readonly db: Db,
    private readonly deps: { chat?: typeof chat; env?: NodeJS.ProcessEnv; retryDelayMs?: number } = {}
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  // ---------------------------------------------------------------- settings

  settings(workspaceId: string): WorkspaceAiSettings {
    const r = this.db.prepare('SELECT * FROM workspace_ai_settings WHERE workspace_id = ?').get(workspaceId) as Row | undefined;
    if (!r) return { mode: 'off', dailyTokenBudget: DEFAULT_DAILY_TOKEN_BUDGET, updatedBy: null, updatedAt: null };
    return { mode: r.mode as AiMode, dailyTokenBudget: Number(r.daily_token_budget), updatedBy: r.updated_by == null ? null : String(r.updated_by), updatedAt: String(r.updated_at) };
  }

  setSettings(workspaceId: string, input: { mode?: unknown; dailyTokenBudget?: unknown }, userId: string): WorkspaceAiSettings {
    const current = this.settings(workspaceId);
    const mode = input.mode === undefined ? current.mode : input.mode;
    if (!AI_MODES.includes(mode as AiMode)) throw new Error(`mode must be one of ${AI_MODES.join(', ')}`);
    const budget = input.dailyTokenBudget === undefined ? current.dailyTokenBudget : Number(input.dailyTokenBudget);
    // The server operator's ceiling (LEXCOMPILER_AI_MAX_DAILY_TOKENS) protects a prepaid key from any one workspace.
    const ceiling = Number(this.env.LEXCOMPILER_AI_MAX_DAILY_TOKENS) || 50_000_000;
    if (!Number.isInteger(budget) || budget < 0 || budget > ceiling) throw new Error(`dailyTokenBudget must be a whole number between 0 and ${ceiling.toLocaleString('en-US')}`);
    this.db
      .prepare(
        `INSERT INTO workspace_ai_settings (workspace_id, mode, daily_token_budget, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET mode = excluded.mode, daily_token_budget = excluded.daily_token_budget, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(workspaceId, mode as string, budget, userId, nowIso());
    return this.settings(workspaceId);
  }

  /** Mode for a call: the workspace's setting, or for the demo screens LEXCOMPILER_DEMO_AI_MODE (default local). */
  modeFor(workspaceId: string | null, requested?: AiMode): AiMode {
    if (workspaceId) return this.settings(workspaceId).mode;
    const demo = (this.env.LEXCOMPILER_DEMO_AI_MODE || 'local') as AiMode;
    if (!AI_MODES.includes(demo) || demo === 'off') return 'off';
    return requested && requested !== 'off' ? requested : demo;
  }

  /** The daily budget in force: the workspace's setting, never above the server's ceiling. */
  effectiveBudget(workspaceId: string): number {
    const ceiling = Number(this.env.LEXCOMPILER_AI_MAX_DAILY_TOKENS) || Infinity;
    return Math.min(this.settings(workspaceId).dailyTokenBudget, ceiling);
  }

  tokensUsedToday(workspaceId: string, now = new Date()): number {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const r = this.db
      .prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_calls WHERE workspace_id = ? AND created_at >= ?')
      .get(workspaceId, since) as Row;
    return Number(r.n);
  }

  listCalls(workspaceId: string | null, limit = 50): AiCallRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM ai_calls WHERE ${workspaceId ? 'workspace_id = ?' : 'workspace_id IS NULL'} ORDER BY created_at DESC LIMIT ?`)
      .all(...(workspaceId ? [workspaceId] : []), Math.min(Math.max(limit, 1), 500)) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: r.workspace_id == null ? null : String(r.workspace_id),
      task: String(r.task),
      mode: r.mode as AiMode,
      provider: String(r.provider),
      model: String(r.model),
      endpointHost: String(r.endpoint_host),
      promptSha256: String(r.prompt_sha256),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cachedTokens: Number(r.cached_tokens),
      latencyMs: Number(r.latency_ms),
      outcome: r.outcome as AiCallRecord['outcome'],
      error: r.error == null ? null : String(r.error),
      createdAt: String(r.created_at),
    }));
  }

  // ---------------------------------------------------------------- calls

  /** One prompt, one answer (JSON when a schema is given). Never throws for model problems. */
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const mode = this.modeFor(req.workspaceId, req.mode);
    const base = { text: '', mode, model: '', endpointHost: '', usage: EMPTY_USAGE(), latencyMs: 0 };
    if (mode === 'off') return { ...base, ok: false, refused: 'ai_off' };
    const cfg = modelForTask(req.task, mode, { localModel: req.localModel, env: this.env });
    if (!cfg) return { ...base, ok: false, refused: 'no_model' };
    const endpointHost = new URL(cfg.baseUrl).host;
    const model = cfg.model;
    if (req.workspaceId) {
      if (this.tokensUsedToday(req.workspaceId) >= this.effectiveBudget(req.workspaceId)) return { ...base, model, endpointHost, ok: false, refused: 'budget' };
    }

    const messages: ChatMessage[] = [...(req.system ? [{ role: 'system' as const, content: req.system }] : []), { role: 'user', content: req.prompt }];
    const usage = EMPTY_USAGE();
    const t0 = performance.now();
    const opts = { jsonSchema: req.schema, maxTokens: req.maxTokens, timeoutMs: req.timeoutMs };
    const promptSha256 = sha256Hex(`${req.system ?? ''}\n\n${req.prompt}`);
    const add = (u: LlmUsage) => {
      for (const k of Object.keys(usage) as Array<keyof LlmUsage>) usage[k] += u[k];
    };
    try {
      let res = await this.callWithRetry(cfg, messages, [], opts);
      add(res.usage);
      if (!req.schema) {
        const latencyMs = Math.round(performance.now() - t0);
        this.log({ workspaceId: req.workspaceId, task: req.task, mode, cfg, promptSha256, usage, latencyMs, outcome: 'ok' });
        return { ok: true, text: res.content, mode, model, endpointHost, usage, latencyMs };
      }
      let json = extractJsonObject(res.content);
      let problem = checkJson(json, req.validate);
      if (problem) {
        // One correction turn, as in the agent runtime.
        res = await this.callWithRetry(cfg, [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: `Your answer is invalid: ${problem}. Reply with only the JSON object.` }], [], opts);
        add(res.usage);
        json = extractJsonObject(res.content);
        problem = checkJson(json, req.validate);
      }
      const latencyMs = Math.round(performance.now() - t0);
      this.log({ workspaceId: req.workspaceId, task: req.task, mode, cfg, promptSha256, usage, latencyMs, outcome: problem ? 'invalid_output' : 'ok', error: problem ?? undefined });
      return problem
        ? { ok: false, invalid: problem, text: res.content, mode, model, endpointHost, usage, latencyMs }
        : { ok: true, text: res.content, json, mode, model, endpointHost, usage, latencyMs };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const message = err instanceof Error ? err.message : String(err);
      this.log({ workspaceId: req.workspaceId, task: req.task, mode, cfg, promptSha256, usage, latencyMs, outcome: 'error', error: message });
      return { ok: false, error: message, text: '', mode, model, endpointHost, usage, latencyMs };
    }
  }

  // ---------------------------------------------------------------- agents

  /** Cloud tokens the agents may use per UTC day (LEXCOMPILER_AGENT_MAX_DAILY_TOKENS, default 100,000). Local models are free and not counted. */
  agentBudget(): number {
    const n = Number(this.env.LEXCOMPILER_AGENT_MAX_DAILY_TOKENS);
    return Number.isFinite(n) && n >= 0 && this.env.LEXCOMPILER_AGENT_MAX_DAILY_TOKENS?.trim() ? n : DEFAULT_AGENT_DAILY_TOKENS;
  }

  /** Cloud tokens used today by agent calls (tasks named agent-…). */
  agentTokensToday(now = new Date()): number {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_calls WHERE task LIKE 'agent-%' AND mode = 'cloud' AND created_at >= ?`)
      .get(since) as Row;
    return Number(r.n);
  }

  private assertAgentBudget(cfg: LlmConfig, task: string): void {
    if (!task.startsWith('agent-') || isLocalHost(cfg.baseUrl)) return;
    const used = this.agentTokensToday();
    const budget = this.agentBudget();
    if (used >= budget) throw new AgentBudgetError(used, budget);
  }

  /**
   * Relays one OpenAI-style chat completion for an agent to the model configured for it
   * (LEXCOMPILER_AGENT_<ID>_*). The agent frameworks (CrewAI, DSPy, Pydantic-AI, the OpenAI
   * Agents SDK) never see a provider key; the call is budgeted and logged like every other.
   */
  async relayAgentChat(agentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!/^agent-[a-z0-9-]{1,60}$/.test(agentId)) throw new AgentRelayError(400, `"model" must be an agent id such as agent-z3-formal-critic, got "${agentId.slice(0, 80)}".`);
    const cfg = llmConfigFor(agentId, this.env);
    if (!cfg) throw new AgentRelayError(404, `No model is configured for ${agentId}. Set ${agentEnvPrefix(agentId)}MODEL (and PROVIDER, BASE_URL, API_KEY) on the server.`);
    if (cfg.provider !== 'openai') throw new AgentRelayError(501, `${agentId} is configured for the ${cfg.provider} API; the agent route relays OpenAI-compatible APIs only (Anthropic also offers one at https://api.anthropic.com/v1).`);
    if (body.stream) throw new AgentRelayError(400, 'Streaming is not supported on the agent route; send stream: false.');
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new AgentRelayError(400, '"messages" must be a non-empty array.');
    this.assertAgentBudget(cfg, agentId);

    const wire = relayBody(body, cfg);
    const t0 = performance.now();
    const promptSha256 = sha256Hex(JSON.stringify(wire.messages));
    const mode: AiMode = isLocalHost(cfg.baseUrl) ? 'local' : 'cloud';
    const meta = { workspaceId: null, task: agentId, mode, cfg, promptSha256 };
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(wire),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log({ ...meta, usage: EMPTY_USAGE(), latencyMs: Math.round(performance.now() - t0), outcome: 'error', error: message });
      throw new AgentRelayError(502, `The model endpoint ${new URL(cfg.baseUrl).host} did not answer: ${message}`);
    }
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      this.log({ ...meta, usage: EMPTY_USAGE(), latencyMs, outcome: 'error', error: `(${res.status}) ${text.slice(0, 300)}` });
      // A rejected request (4xx) is passed on as 400, so SDK clients do not retry it.
      throw new AgentRelayError(res.status >= 500 ? 502 : 400, `${new URL(cfg.baseUrl).host} answered ${res.status}: ${text.slice(0, 300)}`);
    }
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.log({ ...meta, usage: EMPTY_USAGE(), latencyMs, outcome: 'error', error: 'non-JSON answer' });
      throw new AgentRelayError(502, `${new URL(cfg.baseUrl).host} answered with something that is not JSON.`);
    }
    const u = (out.usage || {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number };
    const usage: LlmUsage = {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      cachedPromptTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      cacheWriteTokens: 0,
    };
    this.log({ ...meta, usage, latencyMs, outcome: 'ok' });
    return out;
  }

  /** A logged chat turn with tools, for the agent runtime (which runs its own tool loop). */
  async chatLogged(
    cfg: LlmConfig,
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { jsonSchema?: Record<string, unknown>; maxTokens?: number; timeoutMs?: number },
    meta: { workspaceId: string | null; task: string }
  ): Promise<ChatResult> {
    this.assertAgentBudget(cfg, meta.task);
    const t0 = performance.now();
    const promptSha256 = sha256Hex(JSON.stringify(messages));
    const mode: AiMode = isLocalHost(cfg.baseUrl) ? 'local' : 'cloud';
    try {
      const res = await this.callWithRetry(cfg, messages, tools, opts);
      this.log({ ...meta, mode, cfg, promptSha256, usage: res.usage, latencyMs: Math.round(performance.now() - t0), outcome: 'ok' });
      return res;
    } catch (err) {
      this.log({ ...meta, mode, cfg, promptSha256, usage: EMPTY_USAGE(), latencyMs: Math.round(performance.now() - t0), outcome: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Retries once after a rate limit (429) or a server error (5xx), which are often momentary. */
  private async callWithRetry(...args: Parameters<typeof chat>): Promise<ChatResult> {
    const call = this.deps.chat ?? chat;
    try {
      return await call(...args);
    } catch (err) {
      if (!(err instanceof Error) || !/failed \((?:429|5\d\d)\)/.test(err.message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? 1000));
      return call(...args);
    }
  }

  private log(entry: {
    workspaceId: string | null;
    task: string;
    mode: AiMode;
    cfg: LlmConfig;
    promptSha256: string;
    usage: LlmUsage;
    latencyMs: number;
    outcome: AiCallRecord['outcome'];
    error?: string;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO ai_calls (id, workspace_id, task, mode, provider, model, endpoint_host, prompt_sha256, input_tokens, output_tokens, cached_tokens, latency_ms, outcome, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          entry.workspaceId,
          entry.task.slice(0, 80),
          entry.mode,
          entry.mode === 'local' ? 'ollama' : entry.cfg.provider,
          entry.cfg.model.slice(0, 200),
          new URL(entry.cfg.baseUrl).host,
          entry.promptSha256,
          entry.usage.promptTokens,
          entry.usage.completionTokens,
          entry.usage.cachedPromptTokens,
          entry.latencyMs,
          entry.outcome,
          entry.error ? entry.error.slice(0, 500) : null,
          nowIso()
        );
    } catch {
      // A logging failure never breaks the call it describes.
    }
  }
}

function checkJson(json: unknown, validate?: (value: unknown) => string | null): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'the answer must be one JSON object';
  return validate ? validate(json) : null;
}

let shared: AiGateway | null = null;

/** The server's gateway, on the product database. */
export function getAiGateway(): AiGateway {
  return (shared ??= new AiGateway(getDb()));
}
