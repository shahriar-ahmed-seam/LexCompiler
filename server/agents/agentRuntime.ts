import { performance } from 'node:perf_hooks';
import { handleMcpMessage } from '../mcp/mcpSuite.js';
import { recordLlmUsage } from '../optimization/neuralCompression.js';
import type { LegalClause, TargetRepoFile } from '../../shared/types.js';
import { getAiGateway } from '../ai/gateway.js';
import type { ChatMessage, LlmConfig, LlmUsage, ToolSpec } from './llmClient.js';

/** Structured result every agent must return. */
export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['summary', 'keyFacts', 'confidence'],
  properties: {
    summary: { type: 'string', description: 'Two-sentence summary grounded in the tool results.' },
    keyFacts: { type: 'array', items: { type: 'string' }, description: 'Facts taken from tool results (files, lines, clause ids, statuses).' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export interface AgentOutput {
  summary: string;
  keyFacts: string[];
  confidence: number;
}

export interface AgentRun {
  output: AgentOutput;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean; latencyMs: number }>;
  turns: number;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
}

const MAX_TOOL_RESULT_CHARS = 8000;

/** Validates the agent's final JSON against AGENT_OUTPUT_SCHEMA; returns an error message or null. */
export function validateAgentOutput(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'the answer must be a JSON object';
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== 'string' || !o.summary.trim()) return '"summary" must be a non-empty string';
  if (!Array.isArray(o.keyFacts) || !o.keyFacts.every((f) => typeof f === 'string')) return '"keyFacts" must be an array of strings';
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) return '"confidence" must be a number between 0 and 1';
  return null;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Runs one agent: the model sees the agent's role, the task, and the MCP tools of its server;
 * every tool call is executed for real through the MCP JSON-RPC handler and its result fed
 * back, until the model returns the structured answer (validated, with one correction turn).
 */
export async function runAgent(params: {
  agentId: string;
  role: string;
  task: string;
  mcpServerId: string;
  clauses: LegalClause[];
  llm: LlmConfig;
  maxTurns?: number;
  /** The repository the agent's tools read (default: the bundled target repository). */
  files?: TargetRepoFile[];
}): Promise<AgentRun> {
  const t0 = performance.now();
  const list = await handleMcpMessage(params.mcpServerId, { jsonrpc: '2.0', id: 'list', method: 'tools/list' }, params.clauses);
  const tools: ToolSpec[] = ((list?.result as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> })?.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${params.role}\nYou act through the tools of the MCP server "${params.mcpServerId}". Call tools to obtain facts; never invent results. When you are done, reply with only a JSON object matching this schema:\n${JSON.stringify(AGENT_OUTPUT_SCHEMA)}`,
    },
    { role: 'user', content: params.task },
  ];
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, cacheWriteTokens: 0 };
  const toolCalls: AgentRun['toolCalls'] = [];
  let corrected = false;
  for (let turn = 1; turn <= (params.maxTurns ?? 6); turn++) {
    // Logged in ai_calls like every other model call.
    const res = await getAiGateway().chatLogged(params.llm, messages, tools, { jsonSchema: AGENT_OUTPUT_SCHEMA }, { workspaceId: null, task: params.agentId });
    for (const k of Object.keys(usage) as Array<keyof LlmUsage>) usage[k] += res.usage[k];
    recordLlmUsage(res.usage);
    if (res.toolCalls.length) {
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const s0 = performance.now();
        const out = await handleMcpMessage(params.mcpServerId, { jsonrpc: '2.0', id: call.id, method: 'tools/call', params: { name: call.name, arguments: call.arguments } }, params.clauses, params.files);
        const result = out?.result as { content?: Array<{ text: string }>; isError?: boolean } | undefined;
        const text = result?.content?.map((c) => c.text).join('\n') || out?.error?.message || '';
        toolCalls.push({ name: call.name, arguments: call.arguments, ok: Boolean(result && !result.isError), latencyMs: Math.round((performance.now() - s0) * 100) / 100 });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)` : text });
      }
      continue;
    }
    const parsed = extractJson(res.content);
    const problem = validateAgentOutput(parsed);
    if (!problem) {
      return { output: parsed as AgentOutput, toolCalls, turns: turn, usage, model: params.llm.label || params.llm.model, latencyMs: Math.round(performance.now() - t0) };
    }
    if (corrected) throw new Error(`Agent ${params.agentId} returned invalid output: ${problem}`);
    corrected = true;
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: `Your answer is invalid: ${problem}. Reply with only the JSON object.` });
  }
  throw new Error(`Agent ${params.agentId} did not finish within ${params.maxTurns ?? 6} turns`);
}
