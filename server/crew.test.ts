import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREW, CrewRunStore, importedRun, runCrew, validateImportedRun, type CallTool } from './agents/crew.js';
import type { LlmConfig } from './agents/llmClient.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { executeMcpTool } from './mcp/mcpSuite.js';

const clauses = getInitialClauses();
const retention = clauses.find((c) => c.category === 'RETENTION_AND_TENANT_KMS')!;

/** The real tools, except a fixed regulatory feed and optional overrides. */
function tools(overrides: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {}) {
  const calls: Array<{ tool: string; clauseIds: string[] }> = [];
  const call: CallTool = async (server, tool, args, cls) => {
    calls.push({ tool, clauseIds: cls.map((c) => c.id) });
    if (overrides[tool]) return overrides[tool](args);
    if (tool === 'fetch_live_regulatory_feed') {
      return { totalStatutesFetched: 2, items: [
        { id: 'FEED-1', source: 'EUR_LEX', title: 'Retention notice', excerpt: retention.rawLegalText, url: 'https://example.test/1' },
        { id: 'FEED-2', source: 'FEDERAL_REGISTER', title: 'Unrelated notice', excerpt: 'Fees for grazing permits on federal land.', url: 'https://example.test/2' },
      ] };
    }
    return executeMcpTool(server, tool, args, cls);
  };
  return { call, calls };
}

describe('agent crew', () => {
  it('passes each agent the previous one’s findings, and checks only what the feed touched', async () => {
    const t = tools();
    const run = await runCrew(clauses, { callTool: t.call });

    expect(run.status).toBe('COMPLETED');
    expect(run.steps.map((s) => s.agentId)).toEqual([
      'agent-horizon-scanner', 'agent-deontic-extractor', 'agent-polyglot-ast-mapper',
      'agent-contextual-graph-rag', 'agent-z3-formal-critic', 'agent-remediation-pr-enforcer',
    ]);
    for (let i = 1; i < 6; i++) expect(run.steps[i].received).toEqual(run.steps[i - 1].handoff);

    // The feed item about retention selects the retention rule only.
    expect(run.steps[0].handoff.clauseIds).toEqual([retention.id]);
    expect(run.steps[1].handoff.rules).toEqual([expect.objectContaining({ id: retention.id, formula: expect.stringContaining('72') })]);
    // Steps 3 to 6 run on the compiled rule, not on every active clause.
    for (const tool of ['scan_polyglot_repository_ast', 'hybrid_contextual_graph_rag_query', 'prove_repository_compliance_z3', 'synthesize_and_verify_remediation_pr']) {
      expect(t.calls.find((c) => c.tool === tool)?.clauseIds).toEqual([retention.id]);
    }
    // The RAG query starts from the mapper's locations.
    const locations = (run.steps[2].handoff.locations as Record<string, string[]>)[retention.id];
    expect(locations.length).toBeGreaterThan(0);
    expect(run.steps[3].handoff.query).toContain(locations[0]);
    // Z3 refutes it, and the patch passes the sandbox gate.
    expect(run.steps[4].handoff.unsat).toEqual([expect.objectContaining({ clauseId: retention.id })]);
    expect(run.steps[5].handoff).toMatchObject({ postPatchZ3Status: 'SAT_COMPLIANT', gatePassed: true, clauseIds: [retention.id] });
    expect(run.gate).toBe('PATCH_VERIFIED');
    expect(run.totalTokens).toBe(0);
    expect(run.steps.every((s) => s.execution === 'DIRECT_TOOL_CALL')).toBe(true);
  });

  it('checks every active rule when no feed item matches one', async () => {
    const t = tools({ fetch_live_regulatory_feed: () => ({ items: [{ id: 'X', title: 'Grazing fees', excerpt: 'Fees for grazing permits.' }] }) });
    const run = await runCrew(clauses, { callTool: t.call });
    expect(run.steps[0].handoff.clauseIds).toEqual(clauses.map((c) => c.id));
    expect(run.steps[0].handoff.reason).toMatch(/checking all active rules/);
  }, 60_000);

  it('skips remediation when Z3 refutes nothing', async () => {
    const t = tools({ prove_repository_compliance_z3: () => ({ verdicts: [{ clauseId: retention.id, citation: retention.citation, status: 'SAT_COMPLIANT', unsatCore: [], offendingLocations: [] }] }) });
    const run = await runCrew(clauses, { callTool: t.call });
    expect(run.steps[5]).toMatchObject({ status: 'SKIPPED', summary: expect.stringMatching(/Nothing to fix/) });
    expect(run.gate).toBe('NOTHING_TO_FIX');
    expect(t.calls.some((c) => c.tool === 'synthesize_and_verify_remediation_pr')).toBe(false);
  });

  it('stops the chain at a failed step', async () => {
    const t = tools({ scan_polyglot_repository_ast: () => { throw new Error('parser crashed'); } });
    const run = await runCrew(clauses, { callTool: t.call });
    expect(run.steps.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED', 'FAILED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
    expect(run.steps[2].error).toBe('parser crashed');
    expect(run.status).toBe('FAILED');
    expect(run.gate).toBe('INCOMPLETE');
  });

  describe('with a model', () => {
    const prompts: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const json = JSON.parse(body);
        prompts.push(JSON.stringify(json.messages));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ summary: 'Model says the clause fails.', keyFacts: ['made-up.py:1'], confidence: 0.4 }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }));
      });
    });
    let llm: LlmConfig;
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      llm = { provider: 'openai', model: 'fake', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, label: 'fake model' };
    });
    afterAll(() => server.close());

    it('lets each model read what it received, but hands on tool facts only', async () => {
      const t = tools();
      const run = await runCrew(clauses, { callTool: t.call, useModels: true, llmFor: () => llm });
      expect(run.steps.filter((s) => s.execution === 'LLM_AGENT')).toHaveLength(6);
      expect(run.steps[0].modelReport?.summary).toBe('Model says the clause fails.');
      expect(run.totalTokens).toBe(6 * 55);
      // The deontic extractor's model saw the horizon scanner's handoff.
      expect(prompts[1]).toContain('FEED-1');
      // The model's made-up location never reaches the next agent.
      expect(JSON.stringify(run.steps.map((s) => s.handoff))).not.toContain('made-up.py');
      expect(run.gate).toBe('PATCH_VERIFIED');
    });

    it('keeps the tool facts when the model fails', async () => {
      const broken: LlmConfig = { ...llm, baseUrl: 'http://127.0.0.1:9' };
      const run = await runCrew(clauses, { callTool: tools().call, useModels: true, llmFor: (id) => (id === 'agent-z3-formal-critic' ? broken : null) });
      expect(run.steps[4]).toMatchObject({ status: 'COMPLETED', execution: 'LLM_AGENT', modelError: expect.any(String) });
      expect(run.steps[4].handoff.unsat).toHaveLength(1);
      expect(run.steps[0].execution).toBe('DIRECT_TOOL_CALL');
    });
  });

  it('stores runs and lists them newest first', async () => {
    const db = openDatabase(':memory:');
    const store = new CrewRunStore(db);
    const run = await runCrew(clauses, { callTool: tools().call });
    store.save(run);
    store.save({ ...run, id: 'later', startedAt: new Date(Date.now() + 1000).toISOString() });
    expect(store.get(run.id)?.steps).toHaveLength(6);
    expect(store.list().map((r) => r.id)).toEqual(['later', run.id]);
    expect(store.list()[0].stepStatuses).toEqual(run.steps.map((s) => s.status));
    expect(store.get('nope')).toBeNull();
  });

  it('stores a Python crew run with each agent\u2019s tokens from the call log', () => {
    const db = openDatabase(':memory:');
    const log = db.prepare("INSERT INTO ai_calls (id, task, mode, provider, model, endpoint_host, prompt_sha256, input_tokens, output_tokens, latency_ms, outcome, created_at) VALUES (?, ?, 'cloud', 'openai', 'deepseek-chat', 'api.deepseek.com', 'x', ?, ?, 1, 'ok', ?)");
    log.run('a', 'agent-z3-formal-critic', 900, 100, '2026-10-30T10:00:05.000Z');
    log.run('b', 'agent-z3-formal-critic', 40, 10, '2026-10-30T09:00:00.000Z'); // before the run: not counted
    log.run('c', 'agent-horizon-scanner', 300, 20, '2026-10-30T10:00:01.000Z');
    const steps = CREW.map((a, i) => ({ agentId: a.agentId, status: i < 5 ? 'COMPLETED' : 'FAILED', summary: `step ${i + 1}`, handoff: { summary: 'x' }, error: i === 5 ? 'RuntimeError: no' : undefined, latencyMs: 10 }));
    const run = importedRun(db, { startedAt: '2026-10-30T10:00:00Z', finishedAt: '2026-10-30T10:01:00Z', gate: 'PATCH_VERIFIED', latencyMs: 60000, steps }, 'api-token');
    expect(run).toMatchObject({ source: 'python', status: 'FAILED', gate: 'INCOMPLETE', totalTokens: 1320, triggeredBy: 'api-token', latencyMs: 60000 });
    expect(run.steps[0]).toMatchObject({ agentName: 'Regulatory horizon scanner', pythonAdapter: 'CrewAI', tool: 'fetch_live_regulatory_feed', tokens: 320 });
    expect(run.steps[4].tokens).toBe(1000);
    expect(run.steps[5]).toMatchObject({ status: 'FAILED', error: 'RuntimeError: no' });
  });

  it('accepts a Python crew run only with the six agents in order', () => {
    const steps = ['agent-horizon-scanner', 'agent-deontic-extractor', 'agent-polyglot-ast-mapper', 'agent-contextual-graph-rag', 'agent-z3-formal-critic', 'agent-remediation-pr-enforcer'].map((agentId) => ({ agentId, status: 'COMPLETED' }));
    expect(validateImportedRun({ steps })).toBeNull();
    expect(validateImportedRun({ steps: steps.slice(1) })).toMatch(/6 agents/);
    expect(validateImportedRun({ steps: [steps[1], steps[0], ...steps.slice(2)] })).toMatch(/step 1 must be agent-horizon-scanner/);
    expect(validateImportedRun({ steps: steps.map((s) => ({ ...s, status: 'DONE' })) })).toMatch(/status/);
    expect(validateImportedRun('x')).toMatch(/JSON object/);
  });
});
