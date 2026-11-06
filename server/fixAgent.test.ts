import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGateway } from './ai/gateway.js';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { CREW, CrewRunStore, type CrewRun, type runCrew } from './agents/crew.js';
import { runWorkspaceCrew } from './agents/workspaceCrew.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { compileClauseSync } from './product/clauses.js';
import { ProductStore, type Repo } from './product/store.js';
import type { TargetRepoFile } from '../shared/types.js';

// A repository where the logging rule fails in a file the template can't patch (api/loans.py).
const LOGGING = '    logger.info(f"new application phone={applicant.phone} national_id={applicant.national_id}")';
const FIXED = '    logger.info(f"new application phone={redact_pii(applicant.phone)} national_id={redact_pii(applicant.national_id)}")';
const LOANS = ['import logging', '', 'from api.privacy import redact_pii', '', 'logger = logging.getLogger("finhealth.loans")', '', '', 'def create_application(applicant, x_tenant_id):', LOGGING, '    return {"status": "received"}', ''].join('\n');
const PRIVACY = ['import hashlib', '', '', 'def redact_pii(value: str) -> str:', '    return "[REDACTED:" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:12] + "]"', ''].join('\n');
const lang = (p: string) => (p.endsWith('.sql') ? 'sql' : p.endsWith('.ts') ? 'typescript' : 'python') as TargetRepoFile['language'];
const files: TargetRepoFile[] = Object.entries({ ...Object.fromEntries(Object.entries(INITIAL_REPO_FILES).map(([p, s]) => [p, s.content])), 'api/privacy.py': PRIVACY, 'api/loans.py': LOANS }).map(
  ([path, content]) => ({ path, language: lang(path), description: '', content, lastModified: '' })
);

/** The fake model fixes api/loans.py and returns other lines unchanged (which the checks discard). */
const prompts: string[] = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const prompt = JSON.stringify(JSON.parse(body).messages);
    prompts.push(prompt);
    const lines = /lines \d+-\d+ to replace:\\n([\s\S]*?)"\}/.exec(prompt)?.[1]?.replace(/\\n/g, '\n').replace(/\\"/g, '"') ?? '';
    const replacement = prompt.includes('api/loans.py') ? FIXED : lines;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ replacement, note: 'Redact the values before logging.' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 30 } }));
  });
});

const db = openDatabase(':memory:');
const store = new ProductStore(db);
const runs = new CrewRunStore(db);
let ws: string;
let repo: Repo;
let ai: AiGateway;

/** A crew run whose template patch failed the gate for R-1 (the logging rule here). */
const blockedCrew = (async (clauses, opts = {}) => {
  const steps = CREW.map((a, i) => ({
    stepNumber: i + 1, agentId: a.agentId, agentName: a.agentName, pythonAdapter: a.pythonAdapter, mcpServer: a.mcpServer, tool: a.tool, received: {},
    handoff: i === 4 ? { unsat: [{ clauseId: clauses[0].id }] } : i === 5 ? { postPatchZ3Status: 'UNSAT_VIOLATION', gatePassed: false } : {},
    summary: i === 5 ? 'Patched 2 file(s) for 1 rule(s); post-patch Z3 UNSAT_VIOLATION, so the gate blocks it.' : 'done',
    execution: 'DIRECT_TOOL_CALL', status: 'COMPLETED', tokens: 0, latencyMs: 1,
  }));
  return { id: `run-${Date.now()}-${Math.random()}`, source: 'server', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), useModels: false, status: 'COMPLETED', gate: 'PATCH_BLOCKED', totalTokens: 0, latencyMs: 5, triggeredBy: opts.triggeredBy ?? null, ...(opts.target ? { target: opts.target } : {}), steps } as CrewRun;
}) as typeof runCrew;

beforeAll(async () => {
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  ws = store.createWorkspace('FinHealth AI', arif.id).id;
  const c = getInitialClauses().find((x) => x.category === 'PII_LOGGING_BAN')!;
  const clause = compileClauseSync({ text: c.rawLegalText, key: 'R-1', title: c.title, citation: c.citation, category: c.category });
  const { version } = store.createRuleDraft({ workspaceId: ws, title: c.title, sourceText: c.rawLegalText, clause, createdBy: arif.id });
  store.approveRuleVersion(ws, version.id, arif.id);
  repo = store.addLocalRepo(ws, 'acme/loans', 'unused');
  ai = new AiGateway(db, { env: { LEXCOMPILER_LLM_PROVIDER: 'openai', LEXCOMPILER_LLM_MODEL: 'fake-cloud', LEXCOMPILER_LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, LEXCOMPILER_LLM_API_KEY: 'test' } });
});

afterAll(() => {
  llm.close();
  db.close();
});

const deps = () => ({ store, runs, readHead: async () => ({ commitSha: 'working-tree', files }), ai, runCrew: blockedCrew });
const opts = { useModels: false, openPullRequest: false, requestedBy: 'arif@example.test', triggeredBy: 'arif@example.test' };

describe('fix agent', () => {
  it('asks no model unless the workspace chose a cloud provider', async () => {
    ai.setSettings(ws, { mode: 'off' }, 'owner');
    const run = await runWorkspaceCrew(deps(), repo, opts);
    expect(run.steps[5].handoff.modelFixes).toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('keeps only the model fixes the checks confirm, and records them in the run', async () => {
    ai.setSettings(ws, { mode: 'cloud' }, 'owner');
    const run = await runWorkspaceCrew(deps(), repo, opts);
    const fixes = run.steps[5].handoff.modelFixes as Array<{ ruleKey: string; path: string; startLine: number; body: string }>;
    // The fixture's own logging findings got unchanged lines back, which Z3 still fails: discarded.
    expect(prompts.length).toBeGreaterThan(1);
    expect(fixes).toEqual([expect.objectContaining({ ruleKey: 'R-1', path: 'api/loans.py', startLine: 9 })]);
    expect(fixes[0].body).toContain(FIXED);
    expect(run.steps[5].summary).toMatch(/The fix agent proposed 1 model-written fix that Z3 checked \(suggestions, not committed\)\.$/);
    expect(run.gate).toBe('PATCH_BLOCKED');
    expect(runs.get(run.id, ws)?.steps[5].handoff.modelFixes).toHaveLength(1);
    expect(ai.listCalls(ws).every((c) => c.task === 'fix')).toBe(true);
  });
});
