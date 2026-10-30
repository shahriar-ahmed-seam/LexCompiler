import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGateway } from './ai/gateway.js';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { hashPassword } from './auth/passwords.js';
import { openDatabase } from './db/index.js';
import { EvidenceLog, verifyEntries } from './evidence/log.js';
import { createWorkspaceMcpHandler } from './mcp/workspaceMcp.js';
import type { FlowDeps } from './product/flows.js';
import { GovernanceStore } from './product/governance.js';
import { createPublicRoutes } from './product/publicRoutes.js';
import { createAuthenticator, createProductRouter } from './product/router.js';
import { databaseSessionStore, ProductStore } from './product/store.js';
import { mountWorkspaceRoutes } from './product/workspaceRoutes.js';
import { recordScanEvidence, ruleDecided } from './product/flows.js';
import { createApiGuard, resolveServerSecurityConfig } from './security.js';

const LOAN_ENDPOINT = `import logging

from fastapi import APIRouter, Header
from pydantic import BaseModel

from api.privacy import redact_pii

logger = logging.getLogger("finhealth.loans")
router = APIRouter()


class LoanApplicant(BaseModel):
    full_name: str
    phone: str
    national_id: str
    requested_amount: int


@router.post("/v1/loan-applications")
async def create_application(applicant: LoanApplicant, x_tenant_id: str = Header(...)):
    logger.info(f"new application phone={redact_pii(applicant.phone)} national_id={redact_pii(applicant.national_id)}")
    return {"status": "received", "tenant": x_tenant_id}
`;

const DPA = 'Section 4.2: Personal data ingested via API endpoints, cached in workers, or persisted in tables must be encrypted at rest with tenant-isolated keys and purged within 72 hours.';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-gov-'));
const reposRoot = path.join(dir, 'repos');
let server: http.Server;
let base: string;
let store: ProductStore;
let gov: GovernanceStore;
let evidence: EvidenceLog;
let ws: string;
const API_TOKEN = 'admin-token-for-tests';
const cookies: Record<string, string> = {};

beforeAll(async () => {
  const db = openDatabase(path.join(dir, 'lexcompiler.db'));
  store = new ProductStore(db);
  gov = new GovernanceStore(db);
  evidence = new EvidenceLog(db);
  const ai = new AiGateway(db);
  const flows: FlowDeps = { store, gov, evidence, queue: null, publicUrl: 'http://lexc.test' };
  fs.mkdirSync(path.join(reposRoot, 'finhealth'), { recursive: true });
  for (const [p, f] of Object.entries(INITIAL_REPO_FILES)) {
    fs.mkdirSync(path.dirname(path.join(reposRoot, 'finhealth', p)), { recursive: true });
    fs.writeFileSync(path.join(reposRoot, 'finhealth', p), f.content);
  }
  const owner = store.upsertUser({ sub: 'password:arif@finhealth.example', email: 'arif@finhealth.example', emailVerified: true, name: 'Arif Hossain' });
  ws = store.createWorkspace('FinHealth AI', owner.id).id;
  for (const [email, name, role] of [
    ['arif@finhealth.example', 'Arif Hossain', 'owner'],
    ['nusrat@finhealth.example', 'Nusrat Jahan', 'legal'],
    ['tanvir@finhealth.example', 'Tanvir Rahman', 'engineer'],
    ['lena@klinikum-spree.example', 'Lena Fischer', 'viewer'],
  ] as const) {
    const u = store.upsertUser({ sub: `password:${email}`, email, emailVerified: true, name });
    gov.setPassword(u.id, await hashPassword(`${name.split(' ')[0]}-correct-horse`));
    store.setMemberRole(ws, u.id, role);
  }
  const config = resolveServerSecurityConfig({ LEXCOMPILER_SIGN_IN: 'password', LEXCOMPILER_API_TOKEN: API_TOKEN });
  const app = express();
  app.use(express.json());
  app.use(createPublicRoutes({ store, gov, evidence }));
  app.post('/mcp', createWorkspaceMcpHandler({ store, gov, flows, getApp: () => null, allowedOrigins: config.allowedOrigins }));
  app.use('/api', createApiGuard(config, createAuthenticator(null, API_TOKEN, databaseSessionStore(store))));
  app.use(
    '/api',
    createProductRouter(store, null, {
      reposRoot,
      ai,
      passwordSignIn: true,
      onRuleDecided: (input) => ruleDecided(flows, input),
      onScanCompleted: (scan, findings) => recordScanEvidence(flows, scan, findings),
      extra: (r, h) => mountWorkspaceRoutes(r, h, { store, gov, evidence, ai, flows, publicUrl: 'http://lexc.test', passwordSignIn: true, secureCookies: false }),
    })
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const api = async (p: string, as: string | null, init: { method?: string; body?: unknown; bearer?: string } = {}) => {
  const res = await fetch(`${base}/api${p}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-LexCompiler-Client': 'test', ...(as ? { cookie: cookies[as] } : {}), ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
};

let rpcId = 0;
const mcp = async (token: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const tool = async (token: string, name: string, args: Record<string, unknown>) => (await mcp(token, 'tools/call', { name, arguments: args })).body.result;

describe('demo cycle: Legal approves, an assistant checks, Legal waives, an auditor verifies', () => {
  it('signs in with email and password, and nothing else gets in', async () => {
    expect((await api('/workspaces', null)).status).toBe(401);
    const bad = await api('/auth/password', null, { body: { email: 'nusrat@finhealth.example', password: 'wrong-password-123' } });
    expect(bad.status).toBe(400);
    for (const who of ['arif', 'nusrat', 'tanvir', 'lena']) {
      const email = who === 'lena' ? 'lena@klinikum-spree.example' : `${who}@finhealth.example`;
      const name = { arif: 'Arif', nusrat: 'Nusrat', tanvir: 'Tanvir', lena: 'Lena' }[who];
      const ok = await api('/auth/password', null, { body: { email: email.toUpperCase(), password: `${name}-correct-horse` } });
      expect(ok.status).toBe(200);
      const set = ok.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/lexc_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
      cookies[who] = set.split(';')[0];
    }
    const me = await api('/auth/me', 'nusrat');
    expect(me.body).toMatchObject({ name: 'Nusrat Jahan', via: 'password-session', workspaces: [expect.objectContaining({ id: ws, role: 'legal' })] });
    // Writes from a cookie session need the client header (CSRF).
    const res = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { cookie: cookies.arif, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    expect(res.status).toBe(403);
  });

  it('Legal analyzes and approves a contract clause; the main branch is scanned', async () => {
    const repo = await api(`/workspaces/${ws}/repos`, null, { body: { name: 'finhealth/core-platform', localPath: 'finhealth' }, bearer: API_TOKEN });
    expect(repo.status).toBe(201);
    // No rules yet: the scan records the code as the baseline.
    expect((await api(`/workspaces/${ws}/repos/${repo.body.id}/scan`, 'tanvir', { body: {} })).status).toBe(200);
    expect((await api(`/workspaces/${ws}/rules/analyze`, 'tanvir', { body: { text: DPA } })).status).toBe(403);
    const card = await api(`/workspaces/${ws}/rules/analyze`, 'nusrat', { body: { text: DPA } });
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ category: 'RETENTION_AND_TENANT_KMS', ai: { mode: 'off', status: 'off' }, value: { value: 72, status: 'confirmed', field: 'maxRetentionHours' } });
    expect(card.body.plainReading).toContain('72 hours');
    expect(card.body.highlights.some((h: { kind: string }) => h.kind === 'value')).toBe(true);
    expect(card.body.impact[0].failing).toBeGreaterThan(0);
    const draft = await api(`/workspaces/${ws}/rules`, 'nusrat', { body: { rawLegalText: DPA, title: 'Retention and tenant keys', category: 'RETENTION_AND_TENANT_KMS', values: { maxRetentionHours: 72 } } });
    expect(draft.status).toBe(201);
    expect((await api(`/workspaces/${ws}/rule-versions/${draft.body.version.id}/approve`, 'arif', { body: {} })).status).toBe(403);
    const approved = await api(`/workspaces/${ws}/rule-versions/${draft.body.version.id}/approve`, 'nusrat', { body: { answers: { model: null, value: 72 } } });
    expect(approved.body.status).toBe('approved');
    const scan = await api(`/workspaces/${ws}/repos/${repo.body.id}/scan`, 'tanvir', { body: {} });
    expect(scan.body.findings.length).toBeGreaterThan(0);
    const overview = await api(`/workspaces/${ws}/overview`, 'lena');
    expect(overview.body.counts).toMatchObject({ rulesInEffect: 1, exceptionsWaiting: 0 });
    expect(overview.body.activity.map((a: { text: string }) => a.text)).toEqual(expect.arrayContaining([expect.stringContaining('Nusrat Jahan approved R-1 v1'), expect.stringMatching(/^Scanned finhealth\/core-platform/)]));
  });

  it("an engineer's coding assistant checks changes over MCP and asks Legal for an exception", async () => {
    const created = await api(`/workspaces/${ws}/tokens`, 'tanvir', { body: { name: 'Kiro on my laptop', days: 30 } });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^lexc_pat_/);
    expect((await api(`/workspaces/${ws}/tokens`, 'tanvir')).body[0]).not.toHaveProperty('token');
    expect((await mcp('lexc_pat_nope', 'tools/list')).status).toBe(401);
    expect((await mcp(token, 'tools/list', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await mcp(token, 'tools/list', {}, { 'MCP-Protocol-Version': '2026-07-28' })).body.error).toMatchObject({ message: 'Unsupported protocol version', data: { supported: ['2025-06-18', '2025-03-26'] } });
    const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Kiro', version: '1' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'lexcompiler' } });
    expect(init.body.result.instructions.slice(0, 512)).toContain('check_changes');
    expect((await mcp(token, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_rules', 'check_changes', 'explain_finding', 'request_exception', 'search_obligations']);

    const rules = await tool(token, 'list_rules', {});
    expect(rules.content[0].text).toContain('R-1 v1');
    const check = await tool(token, 'check_changes', { files: [{ path: 'api/loan_applications.py', content: LOAN_ENDPOINT }] });
    expect(check.isError).toBe(false);
    const fresh = check.structuredContent.findings.filter((f: { state: string }) => f.state === 'new');
    expect(fresh).toEqual([expect.objectContaining({ rule: 'R-1', path: 'api/loan_applications.py', line: 20 })]);
    expect(check.content[0].text).toContain('These block the pull request');

    const explained = await tool(token, 'explain_finding', { rule: 'R-1' });
    expect(explained.content[0].text).toContain('Approved by Nusrat Jahan');
    const found = await tool(token, 'search_obligations', { query: 'how long can we keep personal data' });
    expect(found.structuredContent.results[0].key).toBe('R-1');

    const lenaToken = (await api(`/workspaces/${ws}/tokens`, 'lena', { body: { name: 'viewer', days: 1 } })).body.token;
    expect((await tool(lenaToken, 'request_exception', { fingerprint: fresh[0].fingerprint, reason: 'Storage comes in LN-12.' })).isError).toBe(true);
    const asked = await tool(token, 'request_exception', { fingerprint: fresh[0].fingerprint, rule: 'R-1', path: fresh[0].path, line: fresh[0].line, message: fresh[0].message, reason: 'The endpoint stores nothing yet; storage arrives with LN-12.' });
    expect(asked.isError).toBe(false);
    expect(asked.content[0].text).toContain('waiting for Legal');
    const calls = await api(`/workspaces/${ws}/assistant-calls`, 'arif');
    expect(calls.body.map((c: { tool: string }) => c.tool)).toContain('check_changes');
    expect(calls.body[0]).toMatchObject({ userName: 'Tanvir Rahman', client: 'Kiro' });

    // Only Legal decides; an approval needs a future expiry.
    const [request] = (await api(`/workspaces/${ws}/exceptions?status=requested`, 'nusrat')).body;
    expect(request).toMatchObject({ ruleKey: 'R-1', requesterLabel: 'Tanvir Rahman via Kiro', requestedFrom: 'mcp' });
    expect((await api(`/workspaces/${ws}/exceptions/${request.id}/approve`, 'tanvir', { body: { expiresAt: '2099-01-01' } })).status).toBe(403);
    expect((await api(`/workspaces/${ws}/exceptions/${request.id}/approve`, 'nusrat', { body: { expiresAt: '2001-01-01' } })).status).toBe(400);
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const decided = await api(`/workspaces/${ws}/exceptions/${request.id}/approve`, 'nusrat', { body: { expiresAt: until, note: 'Fine until LN-12 adds storage.' } });
    expect(decided.body).toMatchObject({ status: 'approved', decidedByName: 'Nusrat Jahan' });
    const again = await tool(token, 'check_changes', { files: [{ path: 'api/loan_applications.py', content: LOAN_ENDPOINT }] });
    expect(again.structuredContent.summary).toMatchObject({ new: 0, waived: 1 });

    expect((await api(`/workspaces/${ws}/tokens/${created.body.id}/revoke`, 'tanvir', { body: {} })).body.status).toBe('revoked');
    expect((await mcp(token, 'tools/list')).status).toBe(401);
  });

  it('keeps a signed, unbroken evidence log that an auditor can check without an account', async () => {
    const check = await api(`/workspaces/${ws}/evidence/verify`, 'lena');
    expect(check.body).toMatchObject({ ok: true, problems: [] });
    const types = (await api(`/workspaces/${ws}/evidence`, 'lena')).body.entries.map((e: { header: { type: string } }) => e.header.type);
    expect(types).toEqual(expect.arrayContaining(['rule.approved', 'scan.completed', 'exception.requested', 'exception.approved']));
    expect((await api(`/workspaces/${ws}/shares`, 'tanvir', { body: { label: 'x', periodFrom: '2026-01-01', periodTo: '2099-01-01', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } })).status).toBe(403);
    const share = await api(`/workspaces/${ws}/shares`, 'nusrat', { body: { label: 'Klinikum Spree audit', periodFrom: '2020-01-01', periodTo: '2099-01-01', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } });
    expect(share.status).toBe(201);
    const token = String(share.body.url).split('/share/')[1];
    const pub = await (await fetch(`${base}/api/public/share/${token}`)).json();
    expect(pub).toMatchObject({ workspace: { name: 'FinHealth AI' }, share: { label: 'Klinikum Spree audit' }, verification: { ok: true } });
    expect(pub.rules[0].versions[0]).toMatchObject({ decidedBy: 'Nusrat Jahan', status: 'approved' });
    expect(pub.exceptions[0]).toMatchObject({ rule: 'R-1', status: 'approved', decidedBy: 'Nusrat Jahan' });
    const keys = await (await fetch(`${base}/.well-known/lexcompiler/${ws}/keys.json`)).json();
    expect(verifyEntries(pub.records, keys).ok).toBe(true);
    // Tampering is detected: a changed body, a missing record, a changed header.
    const records = pub.records as Array<{ headerJson: string; signature: string; bodyJson: string }>;
    expect(verifyEntries(records.map((r, i) => (i === 1 ? { ...r, bodyJson: r.bodyJson.replace('R-1', 'R-9') } : r)), keys).problems.join()).toContain('body does not match');
    expect(verifyEntries(records.filter((_, i) => i !== 1), keys).problems.join()).toContain('records missing');
    expect(verifyEntries(records.map((r, i) => (i === 1 ? { ...r, headerJson: r.headerJson.replace('"v":1', '"v":2') } : r)), keys).problems.join()).toContain('bad signature');
    expect((await api(`/workspaces/${ws}/shares/${share.body.id}/views`, 'nusrat')).body).toHaveLength(1);
    await api(`/workspaces/${ws}/shares/${share.body.id}/revoke`, 'nusrat', { body: {} });
    expect((await fetch(`${base}/api/public/share/${token}`)).status).toBe(404);
  });
});
