import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { OidcProvider } from './auth/oidc.js';
import { openDatabase } from './db/index.js';
import { createAuthenticator, createProductRouter } from './product/router.js';
import { databaseSessionStore, ProductStore } from './product/store.js';
import { createApiGuard, resolveServerSecurityConfig } from './security.js';

/** Minimal OpenID provider: discovery, JWKS, and a token endpoint that enforces PKCE. */
async function startIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string; sub: string; roles: string[] }>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get('code') || '');
        const verifier = form.get('code_verifier') || '';
        if (!grant || crypto.createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
        json(200, { id_token: await token(grant.sub, grant.roles, { aud: 'lexcompiler', nonce: grant.nonce }), token_type: 'Bearer' });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (sub: string, roles: string[] = [], extra: Record<string, unknown> = {}, key = privateKey) =>
    new SignJWT({ roles, email: `${sub}@example.test`, email_verified: true, ...extra })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setSubject(sub)
      .setAudience((extra.aud as string) || 'lexcompiler')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  return { issuer, server, token, codes, otherKey: (await generateKeyPair('RS256')).privateKey };
}

let idp: Awaited<ReturnType<typeof startIdp>>;
let api: http.Server;
let base: string;
let oidc: OidcProvider;
let store: ProductStore;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-access-'));
const reposRoot = path.join(dataDir, 'repos');

beforeAll(async () => {
  idp = await startIdp();
  const env = { LEXCOMPILER_OIDC_ISSUER: idp.issuer, LEXCOMPILER_OIDC_CLIENT_ID: 'lexcompiler', LEXCOMPILER_DEFAULT_PROJECT_ROLE: 'viewer' };
  const config = resolveServerSecurityConfig(env);
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  oidc = new OidcProvider(
    { issuer: idp.issuer, clientId: 'lexcompiler', redirectUri: 'http://127.0.0.1/api/auth/callback', audience: ['lexcompiler'], rolesClaim: 'roles', adminRole: 'lexcompiler-admin', scopes: 'openid', secureCookies: false },
    databaseSessionStore(store)
  );
  // A project repository: a copy of the fixture's API module.
  fs.mkdirSync(path.join(reposRoot, 'clinic', 'api'), { recursive: true });
  fs.writeFileSync(path.join(reposRoot, 'clinic', 'api', 'intake.py'), INITIAL_REPO_FILES['api/fastapi_intake.py'].content);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiGuard(config, createAuthenticator(oidc, null)));
  app.use('/api', createProductRouter(store, oidc, { reposRoot }));
  app.get('/api/state', (_req, res) => res.json({ ok: true }));
  app.post('/api/clauses/compile', (_req, res) => res.json({ ok: true }));
  api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  api?.close();
  idp?.server.close();
  // Windows cannot delete an open database file.
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = (p: string, token?: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });

describe('OIDC sign-in', () => {
  it('rejects anonymous, forged, and wrong-audience tokens', async () => {
    expect((await call('/state')).status).toBe(401);
    expect((await call('/state', await idp.token('alice', [], {}, idp.otherKey))).status).toBe(401);
    expect((await call('/state', await idp.token('alice', [], { aud: 'someone-else' }))).status).toBe(401);
    expect((await call('/state', await idp.token('alice'))).status).toBe(200);
    expect((await call('/auth/config')).status).toBe(200);
  });

  it('completes the authorization-code flow with PKCE and opens a session', async () => {
    const login = new URL(await oidc.beginLogin('/dashboard'));
    expect(login.searchParams.get('code_challenge_method')).toBe('S256');
    idp.codes.set('code-1', { challenge: login.searchParams.get('code_challenge')!, nonce: login.searchParams.get('nonce')!, sub: 'bob', roles: [] });
    const { sessionId, principal, returnTo } = await oidc.completeLogin({ code: 'code-1', state: login.searchParams.get('state')! });
    expect(principal).toMatchObject({ sub: 'bob', via: 'oidc-session', globalRole: 'member' });
    expect(returnTo).toBe('/dashboard');
    // State is single-use.
    await expect(oidc.completeLogin({ code: 'code-1', state: login.searchParams.get('state')! })).rejects.toThrow(/state/);

    const cookie = oidc.sessionCookie(sessionId).split(';')[0];
    expect(await (await call('/auth/me', undefined, { headers: { cookie } })).json()).toMatchObject({ sub: 'bob' });
    // Cookie sessions need the client header on writes (CSRF).
    expect((await call('/workspaces', undefined, { method: 'POST', headers: { cookie }, body: '{}' })).status).toBe(403);
  });

  it('applies the default-project role to single-repository endpoints', async () => {
    const viewer = await idp.token('carol');
    expect((await call('/state', viewer)).status).toBe(200);
    expect((await call('/clauses/compile', viewer, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await call('/clauses/compile', await idp.token('root', ['lexcompiler-admin']), { method: 'POST', body: '{}' })).status).toBe(200);
  });
});

describe('workspaces', () => {
  const json = async (res: Response) => ({ status: res.status, body: await res.json() });
  it('isolates workspaces and enforces roles', async () => {
    const alice = await idp.token('alice');
    const dave = await idp.token('dave');
    const nusrat = await idp.token('nusrat');
    const erin = await idp.token('erin');
    const created = await json(await call('/workspaces', alice, { method: 'POST', body: JSON.stringify({ name: 'FinHealth AI' }) }));
    expect(created).toMatchObject({ status: 201, body: { name: 'FinHealth AI', role: 'owner' } });
    const ws = created.body.id as string;
    await call('/workspaces', dave, { method: 'POST', body: JSON.stringify({ name: 'Other Co' }) });

    // Another workspace's member sees nothing, and gets 404 rather than 403.
    expect((await (await call('/workspaces', dave)).json()).map((w: { id: string }) => w.id)).not.toContain(ws);
    for (const p of ['', '/rules', '/members', '/repos', '/scans']) expect((await call(`/workspaces/${ws}${p}`, dave)).status).toBe(404);

    // Invitations become memberships at first sign-in (token emails are <sub>@example.test).
    expect((await call(`/workspaces/${ws}/members`, alice, { method: 'POST', body: JSON.stringify({ email: 'nusrat@example.test', role: 'legal' }) })).status).toBe(201);
    expect((await call(`/workspaces/${ws}/members`, alice, { method: 'POST', body: JSON.stringify({ email: 'erin@example.test', role: 'engineer' }) })).status).toBe(201);
    expect((await call(`/workspaces/${ws}/members`, erin, { method: 'POST', body: JSON.stringify({ email: 'x@example.test', role: 'owner' }) })).status).toBe(404);
    // An unverified email claim must not pick up someone else's invitation.
    const impostor = await idp.token('mallory', [], { email: 'nusrat@example.test', email_verified: false });
    expect((await (await call('/auth/me', impostor)).json()).workspaces).toEqual([]);
    expect((await call(`/workspaces/${ws}`, impostor)).status).toBe(404);
    const me = await (await call('/auth/me', nusrat)).json();
    expect(me.workspaces).toEqual([expect.objectContaining({ id: ws, role: 'legal' })]);
    await call('/auth/me', erin);

    // Only Legal drafts and approves rules; the owner who merges code cannot.
    const text = 'Personal data shall be processed only with consent or another lawful basis.';
    expect((await call(`/workspaces/${ws}/rules`, nusrat, { method: 'POST', body: JSON.stringify({ rawLegalText: text, category: 'NOPE' }) })).status).toBe(400);
    expect((await call(`/workspaces/${ws}/rules`, nusrat, { method: 'POST', body: JSON.stringify({ rawLegalText: text, documentId: 'missing' }) })).status).toBe(404);
    expect((await call(`/workspaces/${ws}/rules`, alice, { method: 'POST', body: JSON.stringify({ rawLegalText: text }) })).status).toBe(403);
    const draft = await json(await call(`/workspaces/${ws}/rules`, nusrat, { method: 'POST', body: JSON.stringify({ rawLegalText: text, title: 'Lawful basis' }) }));
    expect(draft).toMatchObject({ status: 201, body: { rule: { key: 'R-1' }, version: { version: 1, status: 'draft' } } });
    expect(draft.body.version.clause).toMatchObject({ id: 'R-1', category: 'CONSENT_LAWFUL_BASIS' });
    const versionId = draft.body.version.id as string;
    expect((await call(`/workspaces/${ws}/rules-in-effect`, erin).then((r) => r.json())).length).toBe(0);
    expect((await call(`/workspaces/${ws}/rule-versions/${versionId}/approve`, erin, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await call(`/workspaces/${ws}/rule-versions/${versionId}/approve`, alice, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(await json(await call(`/workspaces/${ws}/rule-versions/${versionId}/approve`, nusrat, { method: 'POST', body: '{}' }))).toMatchObject({ status: 200, body: { status: 'approved' } });
    expect((await call(`/workspaces/${ws}/rule-versions/${versionId}/approve`, nusrat, { method: 'POST', body: '{}' })).status).toBe(409);
    expect((await call(`/workspaces/${ws}/rules-in-effect`, erin).then((r) => r.json())).map((r: { ruleKey: string }) => r.ruleKey)).toEqual(['R-1']);

    // The last owner can't be demoted.
    const members = (await (await call(`/workspaces/${ws}/members`, alice)).json()).members as Array<{ userId: string; sub: string }>;
    const aliceId = members.find((m) => m.sub === 'alice')!.userId;
    expect((await call(`/workspaces/${ws}/members/${aliceId}`, alice, { method: 'PUT', body: JSON.stringify({ role: 'viewer' }) })).status).toBe(400);

    // Local folders: administrators only, and only inside the repositories root.
    const root = await idp.token('root', ['lexcompiler-admin']);
    const clinic = JSON.stringify({ name: 'Clinic', localPath: 'clinic' });
    expect((await call(`/workspaces/${ws}/repos`, alice, { method: 'POST', body: clinic })).status).toBe(403);
    expect((await call(`/workspaces/${ws}/repos`, root, { method: 'POST', body: JSON.stringify({ name: 'Escape', localPath: '../../etc' }) })).status).toBe(400);
    const repo = await json(await call(`/workspaces/${ws}/repos`, root, { method: 'POST', body: clinic }));
    expect(repo.status).toBe(201);

    // A scan uses the approved rule versions and records them.
    const scan = await json(await call(`/workspaces/${ws}/repos/${repo.body.id}/scan`, erin, { method: 'POST' }));
    expect(scan).toMatchObject({ status: 200, body: { status: 'completed', filesScanned: 1, ruleVersions: [expect.objectContaining({ ruleKey: 'R-1', versionId })] } });
    expect(scan.body.lexcompilerVersion).toMatch(/^(git:|pkg:)/);
    expect(scan.body.findings.every((f: { ruleKey: string; state: string }) => f.ruleKey === 'R-1' && f.state === 'existing')).toBe(true);
    expect((await call(`/workspaces/${ws}/scans/${scan.body.id}`, dave)).status).toBe(404);
    // AI is off until the owner turns it on; only the owner can change it.
    expect(await json(await call(`/workspaces/${ws}/ai`, erin))).toMatchObject({ status: 200, body: { mode: 'off', tokensUsedToday: 0 } });
    expect((await call(`/workspaces/${ws}/ai`, nusrat, { method: 'PUT', body: JSON.stringify({ mode: 'cloud' }) })).status).toBe(403);
    expect((await call(`/workspaces/${ws}/ai`, alice, { method: 'PUT', body: JSON.stringify({ mode: 'everything' }) })).status).toBe(400);
    expect(await json(await call(`/workspaces/${ws}/ai`, alice, { method: 'PUT', body: JSON.stringify({ mode: 'local', dailyTokenBudget: 5000 }) }))).toMatchObject({
      status: 200,
      body: { mode: 'local', dailyTokenBudget: 5000, models: { local: expect.stringContaining('qwen2.5-coder:0.5b') } },
    });
    expect((await call(`/workspaces/${ws}/ai/calls`, dave)).status).toBe(404);
    expect(await (await call(`/workspaces/${ws}/ai/calls`, erin)).json()).toEqual([]);
    expect((await (await call(`/workspaces/${ws}/scans`, erin)).json())[0]).toMatchObject({ id: scan.body.id, conclusion: scan.body.conclusion });
  });
});

describe('sessions', () => {
  it('survive a restart and store only a hash of the session id', () => {
    const file = path.join(dataDir, 'sessions.db');
    const first = new ProductStore(openDatabase(file));
    const id = first.createSession({ sub: 'arif', globalRole: 'member', via: 'oidc-session' }, 60_000);
    first.db.close();
    // A new process opens the same database.
    const second = new ProductStore(openDatabase(file));
    expect(second.sessionPrincipal(id)).toMatchObject({ sub: 'arif', via: 'oidc-session' });
    const stored = second.db.prepare('SELECT id_sha256 FROM sessions').all() as Array<{ id_sha256: string }>;
    expect(stored.map((r) => r.id_sha256)).not.toContain(id);
    const expired = second.createSession({ sub: 'old', globalRole: 'member', via: 'oidc-session' }, -1);
    expect(second.sessionPrincipal(expired)).toBeNull();
    second.deleteSession(id);
    expect(second.sessionPrincipal(id)).toBeNull();
    second.db.close();
  });
});
