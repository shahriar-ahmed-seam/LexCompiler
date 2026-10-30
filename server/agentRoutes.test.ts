import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGateway, relayBody } from './ai/gateway.js';
import { CREW, type CrewRun, type runCrew } from './agents/crew.js';
import type { LlmConfig } from './agents/llmClient.js';
import { createAgentRouter } from './agents/routes.js';
import { openDatabase } from './db/index.js';

/** An OpenAI-compatible model that records what it was sent. */
const sent: Array<Record<string, unknown>> = [];
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    sent.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  });
});

const db = openDatabase(':memory:');
let origin = '';
let server: http.Server;
const crewCalls: Array<{ useModels?: boolean; triggeredBy?: string | null }> = [];
const fakeCrew = (async (_clauses, opts = {}) => {
  crewCalls.push(opts);
  const steps = CREW.map((a, i) => ({ stepNumber: i + 1, agentId: a.agentId, agentName: a.agentName, pythonAdapter: a.pythonAdapter, mcpServer: a.mcpServer, tool: a.tool, received: {}, handoff: {}, summary: 'done', execution: 'DIRECT_TOOL_CALL', status: 'COMPLETED', tokens: 0, latencyMs: 1 }));
  return { id: `run-${crewCalls.length}`, source: 'server', startedAt: new Date(Date.now() + crewCalls.length).toISOString(), finishedAt: new Date().toISOString(), useModels: Boolean(opts.useModels), status: 'COMPLETED', gate: 'PATCH_VERIFIED', totalTokens: 0, latencyMs: 6, triggeredBy: opts.triggeredBy ?? null, steps } as CrewRun;
}) as typeof runCrew;

beforeAll(async () => {
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  const env = {
    LEXCOMPILER_AGENT_Z3_FORMAL_CRITIC_MODEL: 'fake-model',
    LEXCOMPILER_AGENT_Z3_FORMAL_CRITIC_BASE_URL: modelUrl,
    // A cloud host (never contacted: the budget refuses first), so its tokens count against the budget.
    LEXCOMPILER_AGENT_HORIZON_SCANNER_MODEL: 'deepseek-chat',
    LEXCOMPILER_AGENT_HORIZON_SCANNER_BASE_URL: 'https://api.deepseek.test',
    LEXCOMPILER_AGENT_MAX_DAILY_TOKENS: '1000',
  };
  const gateway = new AiGateway(db, { env });
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const who = req.header('x-test-user');
    res.locals.principal = who ? { sub: who, globalRole: who === 'operator' ? 'admin' : 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use(createAgentRouter({ db, gateway: () => gateway, clauses: () => [], runCrew: fakeCrew }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  model.close();
  db.close();
});

const call = async (path: string, user: string | null, body?: unknown) => {
  const res = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const chat = (user: string | null, body: Record<string, unknown>) => call('/api/agents/llm/v1/chat/completions', user, body);
const hello = [{ role: 'user', content: 'Reply OK.' }];

describe('agent model route', () => {
  it('is for the operator only', async () => {
    for (const user of [null, 'nusrat']) {
      const r = await chat(user, { model: 'agent-z3-formal-critic', messages: hello });
      expect(r.status).toBe(403);
      expect(r.json.error.type).toBe('permission_error');
    }
    expect(sent).toHaveLength(0);
  });

  it('relays to the agent’s configured model, with known fields only and a capped answer, and logs the call', async () => {
    const r = await chat('operator', { model: 'agent-z3-formal-critic', messages: hello, max_tokens: 100_000, temperature: 0, api_key: 'from-the-agent', user: 'x' });
    expect(r.status).toBe(200);
    expect(r.json.choices[0].message.content).toBe('OK');
    const wire = sent.at(-1)!;
    expect(wire).toMatchObject({ model: 'fake-model', stream: false, max_tokens: 4096, temperature: 0, messages: hello });
    expect(wire).not.toHaveProperty('api_key');
    expect(wire).not.toHaveProperty('user');
    const logged = db.prepare("SELECT task, mode, input_tokens, output_tokens, outcome FROM ai_calls WHERE task = 'agent-z3-formal-critic'").all();
    expect(logged).toEqual([expect.objectContaining({ task: 'agent-z3-formal-critic', mode: 'local', input_tokens: 12, output_tokens: 3, outcome: 'ok' })]);
  });

  it('refuses bad requests with the reason', async () => {
    const cases: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ model: 'gpt-4o', messages: hello }, 400, /must be an agent id/],
      [{ model: 'agent-nobody', messages: hello }, 404, /LEXCOMPILER_AGENT_NOBODY_MODEL/],
      [{ model: 'agent-z3-formal-critic', messages: hello, stream: true }, 400, /Streaming/],
      [{ model: 'agent-z3-formal-critic', messages: [] }, 400, /non-empty/],
    ];
    for (const [body, status, message] of cases) {
      const r = await chat('operator', body);
      expect(r.status).toBe(status);
      expect(r.json.error).toMatchObject({ type: 'agent_route_error', message: expect.stringMatching(message) });
    }
  });

  it('answers 429 once the agents’ cloud tokens for the day are used up', async () => {
    const log = db.prepare("INSERT INTO ai_calls (id, task, mode, provider, model, endpoint_host, prompt_sha256, input_tokens, output_tokens, latency_ms, outcome, created_at) VALUES (?, ?, 'cloud', 'openai', 'deepseek-chat', 'api.deepseek.test', 'x', ?, 0, 1, 'ok', ?)");
    log.run('used', 'agent-deontic-extractor', 1000, new Date().toISOString());
    const r = await chat('operator', { model: 'agent-horizon-scanner', messages: hello });
    expect(r.status).toBe(429);
    expect(r.json.error).toMatchObject({ type: 'budget_exceeded', message: expect.stringMatching(/1,000 of 1,000 tokens/) });
    // Local models aren't counted, so the Z3 critic on this machine still runs.
    expect((await chat('operator', { model: 'agent-z3-formal-critic', messages: hello })).status).toBe(200);
  });
});

describe('relayBody for providers without JSON-schema output', () => {
  const deepseek: LlmConfig = { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', jsonMode: 'object' };
  const schema = { type: 'object', properties: { summary: { type: 'string' } } };
  const format = { type: 'json_schema', json_schema: { name: 'r', schema } };

  it('puts the schema into the system prompt and asks for json_object when there are no tools', () => {
    const wire = relayBody({ messages: [{ role: 'system', content: 'Be brief.' }, ...hello], response_format: format }, deepseek);
    expect(wire.response_format).toEqual({ type: 'json_object' });
    const messages = wire.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toMatch(/^Be brief\.\n\nReply with only one JSON object/);
    expect(messages[0].content).toContain(JSON.stringify(schema));
  });

  it('leaves json_object off when there are tools, so the model can still call them, and drops strict', () => {
    const tools = [{ type: 'function', function: { name: 'prove', parameters: {}, strict: true } }];
    const wire = relayBody({ messages: hello, response_format: format, tools }, deepseek);
    expect(wire).not.toHaveProperty('response_format');
    expect((wire.messages as Array<{ role: string; content: string }>)[0]).toMatchObject({ role: 'system', content: expect.stringMatching(/When you have what you need from the tools/) });
    expect(wire.tools).toEqual([{ type: 'function', function: { name: 'prove', parameters: {} } }]);
  });

  it('passes json_schema through for providers that support it', () => {
    const wire = relayBody({ messages: hello, response_format: format }, { ...deepseek, jsonMode: 'schema', baseUrl: 'https://api.openai.com/v1' });
    expect(wire.response_format).toEqual(format);
  });
});

describe('crew run routes', () => {
  it('lets members run the crew without models, but only the operator with models', async () => {
    const member = await call('/api/agents/crew/runs', 'nusrat', {});
    expect(member.status).toBe(201);
    expect(crewCalls.at(-1)).toMatchObject({ useModels: false, triggeredBy: 'nusrat' });

    const before = crewCalls.length;
    expect((await call('/api/agents/crew/runs', 'nusrat', { useModels: true })).status).toBe(403);
    expect(crewCalls).toHaveLength(before);

    const operator = await call('/api/agents/crew/runs', 'operator', { useModels: true });
    expect(operator.status).toBe(201);
    expect(crewCalls.at(-1)).toMatchObject({ useModels: true, triggeredBy: 'operator' });
  });

  it('stores Python crew runs from the operator only, after checking them', async () => {
    const steps = CREW.map((a) => ({ agentId: a.agentId, status: 'COMPLETED', summary: 'ok', handoff: {} }));
    expect((await call('/api/agents/crew/runs/import', 'nusrat', { steps })).status).toBe(403);
    const bad = await call('/api/agents/crew/runs/import', 'operator', { steps: steps.slice(0, 5) });
    expect(bad).toMatchObject({ status: 400, json: { error: expect.stringMatching(/6 agents/) } });
    const ok = await call('/api/agents/crew/runs/import', 'operator', { steps, gate: 'PATCH_VERIFIED' });
    expect(ok.status).toBe(201);

    const stored = await call(`/api/agents/crew/runs/${ok.json.id}`, 'nusrat');
    expect(stored.json).toMatchObject({ source: 'python', gate: 'PATCH_VERIFIED', triggeredBy: 'operator' });
    expect(stored.json.steps[0]).toMatchObject({ agentName: 'Regulatory horizon scanner', pythonAdapter: 'CrewAI' });
  });

  it('lists runs newest first and answers 404 for an unknown one', async () => {
    const list = await call('/api/agents/crew/runs', 'nusrat');
    expect(list.status).toBe(200);
    expect(list.json.runs.length).toBe(3);
    expect(list.json.runs[0]).not.toHaveProperty('steps');
    expect((await call('/api/agents/crew/runs/nope', 'nusrat')).status).toBe(404);
  });
});
