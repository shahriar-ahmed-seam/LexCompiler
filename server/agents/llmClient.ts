/**
 * Minimal chat client with tool calling for two wire protocols:
 * - `openai`: OpenAI-compatible /chat/completions (OpenAI, DeepSeek, Gemini's OpenAI endpoint,
 *   Groq/Together/Fireworks for Llama, vLLM, and Ollama's /v1).
 * - `anthropic`: the Anthropic Messages API (with prompt caching on the system prompt).
 * Usage is returned as reported by the provider, including cached prompt tokens.
 */
export type Provider = 'openai' | 'anthropic';

export interface LlmConfig {
  provider: Provider;
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** Display name for reports, e.g. "DeepSeek-V3 via api.deepseek.com". */
  label?: string;
  /**
   * How to ask for JSON on OpenAI-compatible APIs: `schema` (response_format json_schema),
   * `object` (json_object, for providers without schemas such as DeepSeek) or `none`.
   */
  jsonMode?: 'schema' | 'object' | 'none';
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache (OpenAI cached_tokens, Anthropic cache_read_input_tokens). */
  cachedPromptTokens: number;
  cacheWriteTokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  finishReason: string;
}

const DEFAULT_BASE: Record<Provider, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };

/** The env prefix for a task or agent: agent-z3-formal-critic → LEXCOMPILER_AGENT_Z3_FORMAL_CRITIC_. */
export function agentEnvPrefix(agentId: string): string {
  return `LEXCOMPILER_AGENT_${agentId.replace(/^agent-/, '').replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_`;
}

/** Per-agent config (LEXCOMPILER_AGENT_<ID>_*) falling back to LEXCOMPILER_LLM_*; null when unset. */
export function llmConfigFor(agentId: string | null, env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const key = agentId ? agentEnvPrefix(agentId) : '';
  const pick = (name: string) => (key && env[`${key}${name}`]) || env[`LEXCOMPILER_LLM_${name}`];
  const model = pick('MODEL');
  if (!model) return null;
  const provider = (pick('PROVIDER') || 'openai') as Provider;
  if (provider !== 'openai' && provider !== 'anthropic') throw new Error(`Unknown LLM provider ${provider}`);
  const baseUrl = (pick('BASE_URL') || DEFAULT_BASE[provider]).replace(/\/$/, '');
  const mode = pick('JSON_MODE');
  const jsonMode = mode === 'schema' || mode === 'object' || mode === 'none' ? mode : new URL(baseUrl).hostname.endsWith('deepseek.com') ? 'object' : 'schema';
  return { provider, model, baseUrl, apiKey: pick('API_KEY') || undefined, label: `${model} via ${new URL(baseUrl).host}`, jsonMode };
}

export async function chat(cfg: LlmConfig, messages: ChatMessage[], tools: ToolSpec[], opts: { jsonSchema?: Record<string, unknown>; maxTokens?: number; timeoutMs?: number } = {}): Promise<ChatResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  return cfg.provider === 'anthropic' ? chatAnthropic(cfg, messages, tools, opts, signal) : chatOpenAi(cfg, messages, tools, opts, signal);
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM request to ${new URL(url).host} failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function chatOpenAi(cfg: LlmConfig, messages: ChatMessage[], tools: ToolSpec[], opts: { jsonSchema?: Record<string, unknown>; maxTokens?: number }, signal: AbortSignal): Promise<ChatResult> {
  const wire = messages.map((m) =>
    m.role === 'tool'
      ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      : m.role === 'assistant'
        ? { role: 'assistant', content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}) }
        : { role: m.role, content: m.content }
  );
  const body: Record<string, unknown> = { model: cfg.model, messages: wire, max_tokens: opts.maxTokens ?? 1024, temperature: 0 };
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  if (opts.jsonSchema && !tools.length && cfg.jsonMode !== 'none') {
    body.response_format = cfg.jsonMode === 'object' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'result', schema: opts.jsonSchema, strict: false } };
  }
  const out = await post(`${cfg.baseUrl}/chat/completions`, cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, body, signal);
  const choice = ((out.choices as unknown[]) || [])[0] as { message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string } | undefined;
  const u = (out.usage || {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number };
  return {
    content: choice?.message?.content || '',
    toolCalls: (choice?.message?.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, arguments: safeJson(t.function.arguments) })),
    usage: {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      // OpenAI: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens.
      cachedPromptTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      cacheWriteTokens: 0,
    },
    finishReason: choice?.finish_reason || 'unknown',
  };
}

async function chatAnthropic(cfg: LlmConfig, messages: ChatMessage[], tools: ToolSpec[], opts: { jsonSchema?: Record<string, unknown>; maxTokens?: number }, signal: AbortSignal): Promise<ChatResult> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const wire: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = wire[wire.length - 1];
    if (last && last.role === role) last.content.push(block);
    else wire.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content });
    else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const t of m.toolCalls || []) push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: t.arguments });
    }
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 1024,
    // The system prompt (agent role + clause context) is identical across calls: cache it.
    system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
    messages: wire,
  };
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const out = await post(`${cfg.baseUrl}/messages`, { 'x-api-key': cfg.apiKey || '', 'anthropic-version': '2023-06-01' }, body, signal);
  const blocks = (out.content || []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  const u = (out.usage || {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  return {
    content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), arguments: b.input || {} })),
    usage: {
      promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      completionTokens: u.output_tokens ?? 0,
      cachedPromptTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
    finishReason: String(out.stop_reason || 'unknown'),
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
