import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { createWorkspaceMcpRouter, STATELESS_VERSION, WORKSPACE_MCP_INSTRUCTIONS } from './mcp/workspaceServer.js';
import { WORKSPACE_TOOLS } from './mcp/workspaceTools.js';
import { compileClauseSync } from './product/clauses.js';
import { createProductRouter } from './product/router.js';
import { classifyFindings, scanFiles } from './product/scanner.js';
import { ProductStore, type Repo } from './product/store.js';
import { summarizeFindings } from './product/summary.js';
import { resolveServerSecurityConfig } from './security.js';
import type { TargetRepoFile } from '../shared/types.js';

/** The pull request from the product guide's walkthrough: R-1 fails at api/loan_applications.py:20. */
const PRIVACY = ['import hashlib', '', '', 'def redact_pii(value: str) -> str:', '    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]', '    return f"[REDACTED:{digest}]"', ''].join('\n');
const LOANS = [
  'import logging',
  '',
  'from fastapi import APIRouter, Header',
  'from pydantic import BaseModel',
  '',
  'from api.privacy import redact_pii',
  '',
  'logger = logging.getLogger("finhealth.loans")',
  'router = APIRouter()',
  '',
  '',
  'class LoanApplicant(BaseModel):',
  '    full_name: str',
  '    phone: str',
  '    national_id: str',
  '    requested_amount: int',
  '',
  '',
  '@router.post("/v1/loan-applications")',
  'async def create_application(applicant: LoanApplicant, x_tenant_id: str = Header(...)):',
  '    logger.info(f"new application phone={applicant.phone} national_id={applicant.national_id}")',
  '    return {"status": "received", "tenant": x_tenant_id}',
  '',
].join('\n');
const LOANS_FIXED = LOANS.replace('phone={applicant.phone} national_id={applicant.national_id}', 'phone={redact_pii(applicant.phone)} national_id={redact_pii(applicant.national_id)}');
const CHANGE = [
  { path: 'api/privacy.py', content: PRIVACY },
  { path: 'api/loan_applications.py', content: LOANS },
];
const MAIN_SHA = 'a'.repeat(40);

let server: http.Server;
let origin: string;
let store: ProductStore;
let finhealth: string;
let other: string;
let githubRepo: Repo;
const fixtureFiles: TargetRepoFile[] = Object.entries(INITIAL_REPO_FILES).map(([p, spec]) => ({ path: p, language: spec.language, description: spec.description, content: spec.content, lastModified: '2026-11-01T00:00:00Z' }));
const downloads: string[] = [];
const tokens: Record<string, string> = {};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-mcp-'));

beforeAll(async () => {
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  const user = (sub: string) => store.upsertUser({ sub, email: `${sub}@example.test`, emailVerified: true });
  const arif = user('arif');
  finhealth = store.createWorkspace('FinHealth AI', arif.id).id;
  for (const [sub, role] of [['nusrat', 'legal'], ['tanvir', 'engineer'], ['vera', 'viewer']] as const) {
    store.invite(finhealth, `${sub}@example.test`, role, arif.id);
    store.acceptInvitations(user(sub));
  }
  other = store.createWorkspace('Other Co', user('omar').id).id;

  // FinHealth's rules: the built-in clauses, approved by Arif (R-1 is the logging ban).
  for (const c of getInitialClauses()) {
    const key = store.nextRuleKey(finhealth);
    const clause = compileClauseSync({ text: c.rawLegalText, key, title: c.title, citation: c.citation, category: c.category });
    const { version } = store.createRuleDraft({ workspaceId: finhealth, title: c.title, sourceText: c.rawLegalText, clause, createdBy: arif.id });
    store.approveRuleVersion(finhealth, version.id, arif.id);
  }
  store.addDocument({ workspaceId: finhealth, title: 'Klinikum Spree DPA', kind: 'contract', text: '9. Logging\nPersonal data such as national ID numbers shall not be written to application logs in plain text.\n', uploadedBy: arif.id });

  // A local copy of main, and a GitHub repository whose main was scanned at MAIN_SHA.
  const reposRoot = path.join(dataDir, 'repos');
  for (const f of fixtureFiles) {
    fs.mkdirSync(path.dirname(path.join(reposRoot, 'core-platform', f.path)), { recursive: true });
    fs.writeFileSync(path.join(reposRoot, 'core-platform', f.path), f.content);
  }
  store.addLocalRepo(finhealth, 'core-platform', path.join(reposRoot, 'core-platform'));
  store.upsertInstallation({ installationId: 7, accountLogin: 'acme', accountType: 'Organization' });
  store.upsertGithubRepo({ installationId: 7, githubRepoId: 4242, fullName: 'acme/finhealth-core-platform', defaultBranch: 'main' });
  store.linkInstallation(7, finhealth);
  githubRepo = store.getRepoByGithubId(4242)!;
  const rules = store.rulesInEffect(finhealth);
  const scan = store.createScan({ repoId: githubRepo.id, commitSha: MAIN_SHA, trigger: 'push', rules, lexcompilerVersion: 'test' });
  const result = await scanFiles(fixtureFiles, rules);
  const findings = classifyFindings(result.findings, null);
  store.completeScan(scan.id, { conclusion: 'neutral', filesScanned: result.filesScanned, summary: summarizeFindings(findings, result.undecidedRuleKeys), facts: result.facts, findings });

  for (const [sub, ws] of [['tanvir', finhealth], ['nusrat', finhealth], ['vera', finhealth], ['omar', other]] as const) {
    tokens[sub] = store.createApiToken(ws, store.getUserBySub(sub)!.id, `${sub}'s laptop`).token;
  }

  const app = express();
  app.use(
    '/mcp',
    createWorkspaceMcpRouter({
      store,
      security: resolveServerSecurityConfig({}),
      readRepoFiles: async (repo, sha) => {
        downloads.push(`${repo.fullName}@${sha}`);
        return fixtureFiles;
      },
    })
  );
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const sub = req.header('x-test-user');
    res.locals.principal = sub ? { sub, globalRole: 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use('/api', createProductRouter(store, null, { reposRoot }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let nextId = 1;
/** One JSON-RPC request. `stateless` sends the 2026-07-28 _meta and matching headers. */
async function rpc(method: string, params: Record<string, unknown> = {}, opts: { token?: string | null; stateless?: boolean; headers?: Record<string, string>; notification?: boolean } = {}) {
  const token = opts.token === undefined ? tokens.tanvir : opts.token;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (opts.stateless) {
    body.params = { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': STATELESS_VERSION, clientCapabilities: {}, clientInfo: { name: 'test', version: '1' } } };
    Object.assign(headers, { 'MCP-Protocol-Version': STATELESS_VERSION, 'Mcp-Method': method });
    if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;
  }
  if (!opts.notification) body = { ...body, id: nextId++ };
  const res = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...headers, ...opts.headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
/** tools/call, returning the structured result (or the error text when isError). */
async function tool(name: string, args: Record<string, unknown>, token?: string) {
  const r = await rpc('tools/call', { name, arguments: args }, { token, stateless: true });
  expect(r.status).toBe(200);
  return { isError: r.body.result.isError as boolean, data: r.body.result.structuredContent, text: r.body.result.content[0].text as string };
}

describe('workspace MCP endpoint: transport and protocol', () => {
  it('refuses missing, unknown, revoked and expired tokens, and tokens of former members', async () => {
    const missing = await rpc('ping', {}, { token: null });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect((await rpc('ping', {}, { token: 'lexc_pat_not-a-token' })).status).toBe(401);
    expect((await rpc('ping', {}, { token: 'lexc_pat_not-a-token', headers: { Authorization: 'Basic abc' } })).status).toBe(401);

    const tanvir = store.getUserBySub('tanvir')!;
    const revoked = store.createApiToken(finhealth, tanvir.id, 'old');
    expect((await rpc('ping', {}, { token: revoked.token })).status).toBe(200);
    store.revokeApiToken(finhealth, tanvir.id, revoked.record.id);
    expect((await rpc('ping', {}, { token: revoked.token })).status).toBe(401);

    const expired = store.createApiToken(finhealth, tanvir.id, 'short', 1);
    store.db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.record.id);
    expect((await rpc('ping', {}, { token: expired.token })).status).toBe(401);

    const leaver = store.upsertUser({ sub: 'leaver', email: 'leaver@example.test', emailVerified: true });
    store.invite(finhealth, 'leaver@example.test', 'engineer', store.getUserBySub('arif')!.id);
    store.acceptInvitations(leaver);
    const left = store.createApiToken(finhealth, leaver.id, 'leaver');
    store.removeMember(finhealth, leaver.id);
    expect((await rpc('ping', {}, { token: left.token })).status).toBe(401);

    // Only the hash is stored, and the use is recorded.
    expect(JSON.stringify(store.db.prepare('SELECT * FROM api_tokens').all())).not.toContain(tokens.tanvir);
    expect(store.listApiTokens(finhealth, tanvir.id).find((t) => t.id === revoked.record.id)?.lastUsedAt).toBeTruthy();
  });

  it('answers 403 to a web page on another origin, and 405 to GET and DELETE', async () => {
    expect((await rpc('ping', {}, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await rpc('ping', {}, { headers: { Origin: 'http://localhost:5173' } })).status).toBe(200);
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${origin}/mcp`, { method, headers: { Authorization: `Bearer ${tokens.tanvir}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('keeps the 2025-06-18 initialize handshake', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'lexcompiler' }, capabilities: { tools: {}, prompts: {} }, resultType: 'complete' });
    expect(init.headers.get('mcp-session-id')).toBeNull();
    // The first 512 characters say what the server is for and when to call check_changes.
    const head = String(init.body.result.instructions).slice(0, 512);
    expect(head).toBe(WORKSPACE_MCP_INSTRUCTIONS.slice(0, 512));
    for (const word of ['LexCompiler', 'check_changes', 'pull request check', 'request_exception']) expect(head).toContain(word);

    expect((await rpc('notifications/initialized', {}, { notification: true, headers: { 'MCP-Protocol-Version': '2025-06-18' } })).status).toBe(202);
    const list = await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_rules', 'check_changes', 'explain_finding', 'suggest_fix', 'request_exception', 'search_obligations']);
    // An unknown method on the older revision is a JSON-RPC error with HTTP 200.
    const unknown = await rpc('resources/list', {}, { headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    expect(unknown).toMatchObject({ status: 200, body: { error: { code: -32601 } } });
    expect((await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '1999-01-01' } })).status).toBe(400);
  });

  it('speaks 2026-07-28: _meta, matching headers, server/discover, fixed tool order', async () => {
    const discover = await rpc('server/discover', {}, { stateless: true });
    expect(discover.status).toBe(200);
    expect(discover.body.result).toMatchObject({ supportedVersions: [STATELESS_VERSION, '2025-06-18', '2025-03-26'], resultType: 'complete' });

    const a = await rpc('tools/list', {}, { stateless: true });
    const b = await rpc('tools/list', {}, { stateless: true });
    expect(a.body.result.tools).toEqual(b.body.result.tools);
    for (const t of a.body.result.tools) expect(t.annotations.readOnlyHint).toBe(t.name !== 'request_exception');

    const mismatch = await rpc('tools/list', {}, { stateless: true, headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    expect(mismatch).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    expect((await rpc('tools/list', {}, { stateless: true, headers: { 'Mcp-Method': 'prompts/list' } })).body.error.code).toBe(-32020);
    expect((await rpc('tools/call', { name: 'list_rules', arguments: { repo: 'core-platform' } }, { stateless: true, headers: { 'Mcp-Name': 'search_obligations' } })).body.error.code).toBe(-32020);
    // The header claims 2026-07-28 but the body has no _meta.
    expect((await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': STATELESS_VERSION, 'Mcp-Method': 'tools/list' } })).body.error.code).toBe(-32020);

    const unsupported = await rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } }, { headers: { 'MCP-Protocol-Version': '2099-01-01' } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.data).toMatchObject({ error: 'UnsupportedProtocolVersionError', supported: [STATELESS_VERSION, '2025-06-18', '2025-03-26'] });
    expect(await rpc('nothing/here', {}, { stateless: true })).toMatchObject({ status: 404, body: { error: { code: -32601 } } });

    const prompt = await rpc('prompts/get', { name: 'check-before-commit' }, { stateless: true });
    expect(prompt.body.result.messages[0].content.text).toBe(
      'Call check_changes with every file I changed. Fix new findings, using suggest_fix when it returns a verified diff. Ask me before requesting an exception.'
    );
  });

  it('rate-limits each token', async () => {
    const app = express();
    app.use('/mcp', createWorkspaceMcpRouter({ store, security: resolveServerSecurityConfig({}), readRepoFiles: async () => fixtureFiles, rateLimitPerMinute: 2 }));
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
      const ping = (token: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      expect((await ping(tokens.nusrat)).status).toBe(200);
      expect((await ping(tokens.nusrat)).status).toBe(200);
      const limited = await ping(tokens.nusrat);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      // Another token has its own budget.
      expect((await ping(tokens.vera)).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe('workspace MCP endpoint: tools', () => {
  it("lists the rules in effect, and a token from another workspace can't see FinHealth's", async () => {
    const mine = await tool('list_rules', { repo: 'core-platform' });
    expect(mine.isError).toBe(false);
    expect(mine.data.rules.map((r: { key: string }) => r.key).slice(0, 2)).toEqual(['R-1', 'R-2']);
    expect(mine.data.rules[0]).toMatchObject({ version: 1, scope: ['**'] });

    const theirs = await tool('list_rules', { repo: 'core-platform' }, tokens.omar);
    expect(theirs).toMatchObject({ isError: true });
    expect(theirs.text).toContain('Unknown repository');
    expect(theirs.text).not.toContain('core-platform,');
    expect((await tool('search_obligations', { query: 'logging national ID' }, tokens.omar)).data.results).toEqual([]);
  });

  it('gives the PR check’s answer before the push, and logs paths, not code', async () => {
    const failing = await tool('check_changes', { repo: 'core-platform', files: CHANGE });
    expect(failing.data.conclusion).toBe('failure');
    const fresh = failing.data.findings.filter((f: { state: string }) => f.state === 'new');
    // R-1: the endpoint handles PII without a tenant key (line 20); R-2: it logs PII (line 21).
    expect(fresh.map((f: { rule: string; startLine: number }) => `${f.rule}:${f.startLine}`)).toEqual(['R-1:20', 'R-2:21']);
    expect(fresh[0].path).toBe('api/loan_applications.py');

    expect(failing.data.summary.existing).toBeGreaterThan(0);

    const fixed = await tool('check_changes', { repo: 'core-platform', files: [CHANGE[0], { path: 'api/loan_applications.py', content: LOANS_FIXED }] });
    // Redacting the log line fixes R-2; R-1 still fails until the data is encrypted with a tenant key.
    expect(fixed.data.findings.filter((f: { state: string }) => f.state === 'new').map((f: { rule: string }) => f.rule)).toEqual(['R-1']);
    expect(fixed.data.conclusion).toBe('failure');

    const calls = store.listMcpCalls(finhealth).filter((c) => c.tool === 'check_changes');
    expect(calls[1]).toMatchObject({ outcome: 'ok', repo: 'core-platform', detail: { paths: ['api/privacy.py', 'api/loan_applications.py'], fingerprints: fresh.map((f: { fingerprint: string }) => f.fingerprint) } });
    expect(JSON.stringify(store.db.prepare('SELECT * FROM mcp_calls').all())).not.toContain('national_id');
  });

  it('compares a GitHub repository with its latest scanned main commit, downloaded once', async () => {
    const first = await tool('check_changes', { repo: 'acme/finhealth-core-platform', files: CHANGE });
    expect(first.data).toMatchObject({ baseCommit: MAIN_SHA, conclusion: 'failure' });
    await tool('check_changes', { repo: 'finhealth-core-platform', files: CHANGE });
    expect(downloads).toEqual([`acme/finhealth-core-platform@${MAIN_SHA}`]);
  });

  it('refuses paths outside the repository and oversized calls', async () => {
    expect((await tool('check_changes', { repo: 'core-platform', files: [{ path: '../etc/passwd', content: 'x' }] })).text).toContain('not a path from the repository root');
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.py`, content: '' }));
    expect((await tool('check_changes', { repo: 'core-platform', files: many })).text).toContain('At most 200 files');
    expect((await tool('check_changes', { repo: 'core-platform', files: [{ path: 'big.py', content: 'x'.repeat(2 * 1024 * 1024 + 1) }] })).text).toContain('2 MB');
    expect((await tool('check_changes', { repo: 'core-platform' })).text).toBe('Missing required argument "files".');
  });

  it('explains a finding with its rule, approver and citations, and suggests a Z3-verified fix', async () => {
    const check = await tool('check_changes', { repo: 'core-platform', files: CHANGE });
    const finding = check.data.findings.find((f: { state: string; rule: string }) => f.state === 'new' && f.rule === 'R-2');

    const byFingerprint = await tool('explain_finding', { fingerprint: finding.fingerprint });
    expect(byFingerprint.data.rule).toMatchObject({ key: 'R-2', version: 1, approvedBy: 'arif@example.test' });
    expect(byFingerprint.data.why).toBe(finding.message);
    expect(byFingerprint.data.citations.length).toBeGreaterThan(0);
    const byLine = await tool('explain_finding', { rule: 'R-2', path: 'api/loan_applications.py', line: 21 });
    expect(byLine.data.finding.fingerprint).toBe(finding.fingerprint);

    const fix = await tool('suggest_fix', { repo: 'core-platform', fingerprint: finding.fingerprint, files: CHANGE });
    expect(fix.isError).toBe(false);
    expect(fix.data.verified).toBe(true);
    expect(fix.data.gate).toContain('SAT_COMPLIANT');
    expect(fix.data.diff).toContain('api/loan_applications.py');

    // R-1 needs a tenant KMS client the patcher cannot verify here: it says so instead of guessing.
    const kms = check.data.findings.find((f: { state: string; rule: string }) => f.state === 'new' && f.rule === 'R-1');
    const none = await tool('suggest_fix', { repo: 'core-platform', fingerprint: kms.fingerprint, files: CHANGE });
    expect(none.data).toMatchObject({ verified: false, result: 'no verified fix', unresolvedRules: ['R-1'] });
  });

  it("puts Tanvir's request in Nusrat's inbox; viewers can't ask and no tool approves", async () => {
    const check = await tool('check_changes', { repo: 'core-platform', files: CHANGE });
    const finding = check.data.findings.find((f: { state: string }) => f.state === 'new');
    const until = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();

    expect((await tool('request_exception', { fingerprint: finding.fingerprint, reason: 'x', until }, tokens.vera)).text).toContain('Your role (viewer) cannot request exceptions');
    expect((await tool('request_exception', { fingerprint: finding.fingerprint, reason: 'x', until: '2000-01-01' })).text).toContain('future');

    const asked = await tool('request_exception', { fingerprint: finding.fingerprint, reason: 'The endpoint is behind a feature flag until LN-12', until });
    expect(asked.data).toMatchObject({ status: 'requested', created: true, rule: 'R-1', path: 'api/loan_applications.py', requestedUntil: until });
    expect((await tool('request_exception', { fingerprint: finding.fingerprint, reason: 'again', until })).data).toMatchObject({ exceptionId: asked.data.exceptionId, created: false });

    const inbox = await fetch(`${origin}/api/workspaces/${finhealth}/inbox`, { headers: { 'x-test-user': 'nusrat' } }).then((r) => r.json());
    expect(inbox.exceptionRequests).toEqual([
      expect.objectContaining({ id: asked.data.exceptionId, requestedFrom: 'assistant', requestedBy: store.getUserBySub('tanvir')!.id, requestedUntil: until, startLine: 20 }),
    ]);

    // Nothing over MCP decides it, even with Legal's token.
    const names = WORKSPACE_TOOLS.map((t) => t.name);
    expect(names.some((n) => /approve|decide|reject|edit/.test(n))).toBe(false);
    const approve = await rpc('tools/call', { name: 'approve_exception', arguments: { id: asked.data.exceptionId } }, { token: tokens.nusrat, stateless: true });
    expect(approve.body.error.message).toContain('Unknown tool');
    expect(store.getException(finhealth, asked.data.exceptionId)!.status).toBe('requested');
  });

  it('searches the approved rules and documents with citations', async () => {
    const r = await tool('search_obligations', { query: 'may national ID numbers be written to logs?' });
    expect(r.data.results.length).toBeGreaterThan(0);
    expect(r.data.results.map((x: { citation: string }) => x.citation)).toContain('Klinikum Spree DPA §9');
    for (const x of r.data.results) expect(x.citation).toBeTruthy();
  });
});

describe('workspace MCP endpoint: assistant-friendly behaviour', () => {
  it('answers in plain language beside the structured data, and works without naming a repository when there is one', async () => {
    // Two repositories here: without repo, list_rules covers the whole workspace; check_changes asks which.
    const all = await tool('list_rules', {});
    expect(all.isError).toBe(false);
    expect(all.text).toContain('R-1 v1');
    expect(all.data.repo).toBeNull();
    const ask = await tool('check_changes', { files: CHANGE });
    expect(ask.isError).toBe(true);
    expect(ask.text).toContain('Name the repository');

    const check = await tool('check_changes', { repo: 'core-platform', files: CHANGE });
    expect(check.text).toContain('These block the pull request');
    expect(check.data.findings[0]).toMatchObject({ line: check.data.findings[0].startLine });
  });

  it('explains a rule by its key alone, with guidance on how code satisfies it', async () => {
    const r = await tool('explain_finding', { rule: 'R-2' });
    expect(r.isError).toBe(false);
    expect(r.data.finding).toBeUndefined();
    expect(r.text).toContain('How code usually satisfies it');
    expect(r.data.howToFix).toBeTruthy();
    expect((await tool('explain_finding', {})).text).toContain('Give a fingerprint');
    expect((await tool('explain_finding', { rule: 'R-99' })).text).toContain('No rule R-99');
  });

  it('takes an exception request for a finding it was not shown, with no end date, labelled with the assistant', async () => {
    // The test client names itself in _meta (2026-07-28); the name is kept on the token and labels the request.
    const fingerprint = 'f'.repeat(64);
    const asked = await tool('request_exception', { fingerprint, rule: 'R-2', repo: 'core-platform', path: 'api/new_endpoint.py', line: 7, message: 'Logs a phone number', reason: 'Not on GitHub yet; fixed in LN-13.' });
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain('waiting for Legal');
    expect(asked.data).toMatchObject({ status: 'requested', created: true, rule: 'R-2', path: 'api/new_endpoint.py', requestedUntil: null });
    const stored = store.getException(finhealth, asked.data.exceptionId)!;
    expect(stored).toMatchObject({ requestedFrom: 'assistant', requesterLabel: expect.stringContaining('via test'), startLine: 7 });
    expect((await tool('request_exception', { fingerprint: 'e'.repeat(64), reason: 'no such finding is known' })).text).toContain('not known here');
    const tokenRecord = store.listApiTokens(finhealth, store.getUserBySub('tanvir')!.id).find((t) => t.lastClient === 'test');
    expect(tokenRecord).toBeTruthy();
    const log = store.listMcpCalls(finhealth).find((c) => c.tool === 'request_exception' && c.outcome === 'ok');
    expect(log).toMatchObject({ client: 'test', userId: store.getUserBySub('tanvir')!.id, summary: 'R-2 requested' });
  });

  it('searches rules by meaning when an embedding model answers, and by keyword otherwise', async () => {
    const r = await tool('search_obligations', { query: 'may national ID numbers be written to logs?' });
    expect(['semantic', 'keyword']).toContain(r.data.mode);
    expect(r.text).toContain('Closest approved rules');
    expect(r.data.results[0].key ?? r.data.results[0].documentId).toBeTruthy();
  });
});

describe('personal access tokens API', () => {
  it('creates a token shown once, lists it without the secret, and revokes it', async () => {
    const call = (p: string, body?: unknown) =>
      fetch(`${origin}/api/workspaces/${finhealth}${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-test-user': 'nusrat', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const made = await call('/tokens', { name: 'Kiro', days: 30 });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^lexc_pat_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(made.body.expiresAt) - Date.parse(made.body.createdAt)).toBe(30 * 24 * 3600 * 1000);
    expect((await call('/tokens', { name: 'too long', days: 400 })).status).toBe(400);

    const list = await call('/tokens');
    expect(list.body.mcpUrl).toBe('http://localhost:3001/mcp');
    expect(list.body.tokens.map((t: { name: string }) => t.name)).toContain('Kiro');
    expect(JSON.stringify(list.body)).not.toContain(made.body.token);

    expect((await rpc('ping', {}, { token: made.body.token })).status).toBe(200);
    expect((await call(`/tokens/${made.body.id}/revoke`, {})).body.revokedAt).toBeTruthy();
    expect((await rpc('ping', {}, { token: made.body.token })).status).toBe(401);
  });
});
