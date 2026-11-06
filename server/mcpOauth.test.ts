import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { createOAuthRouter, isAllowedRedirectUri } from './mcp/oauth.js';
import { createWorkspaceMcpRouter } from './mcp/workspaceServer.js';
import { ProductStore } from './product/store.js';
import { resolveServerSecurityConfig } from './security.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-oauth-'));
const REDIRECT = 'http://127.0.0.1:33418/callback';
let server: http.Server;
let base: string;
let store: ProductStore;
let ws: string;

beforeAll(async () => {
  store = new ProductStore(openDatabase(path.join(dir, 'lexcompiler.db')));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  ws = store.createWorkspace('FinHealth AI', arif.id).id;
  store.invite(ws, 'tanvir@example.test', 'engineer', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'tanvir', email: 'tanvir@example.test', emailVerified: true }));
  store.upsertUser({ sub: 'outsider', email: 'outsider@example.test', emailVerified: true });

  const app = express();
  app.use(
    createOAuthRouter({
      store,
      db: store.db,
      publicUrl: 'http://lexc.test',
      principal: async (req) => {
        const sub = req.header('x-test-user');
        return sub ? { sub, email: `${sub}@example.test`, globalRole: 'member', via: 'oidc-session' } : null;
      },
      loginUrl: (returnTo) => `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    })
  );
  app.use('/mcp', createWorkspaceMcpRouter({ store, security: resolveServerSecurityConfig({}), readRepoFiles: async () => [], resourceMetadataUrl: 'http://lexc.test/.well-known/oauth-protected-resource' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  store?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
async function register(redirectUris = [REDIRECT]) {
  return fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Desktop', redirect_uris: redirectUris }) });
}
const authorizeUrl = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
  `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra })}`;
/** Opens the consent page as `user` and submits it; returns the redirect's query. */
async function consent(user: string, clientId: string, challenge: string, decision: 'allow' | 'deny' = 'allow') {
  const pageRes = await fetch(base + authorizeUrl(clientId, challenge), { headers: { 'x-test-user': user }, redirect: 'manual' });
  expect(pageRes.status).toBe(200);
  const html = await pageRes.text();
  const field = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))![1];
  const form = new URLSearchParams({ client_id: field('client_id'), redirect_uri: field('redirect_uri'), code_challenge: field('code_challenge'), state: field('state'), form_token: field('form_token'), workspace_id: ws, decision });
  const res = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { 'x-test-user': user, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
  expect(res.status).toBe(302);
  return { html, location: new URL(res.headers.get('location')!) };
}
const token = (body: Record<string, string>) =>
  fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: await r.json(), cache: r.headers.get('cache-control') }));
const ping = (accessToken: string) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }).then((r) => r.status);

describe('OAuth for the MCP endpoint', () => {
  it('publishes protected-resource and authorization-server metadata, and points 401s at it', async () => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(pr).toMatchObject({ resource: 'http://lexc.test/mcp', authorization_servers: ['http://lexc.test'] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ issuer: 'http://lexc.test', token_endpoint: 'http://lexc.test/oauth/token', registration_endpoint: 'http://lexc.test/oauth/register', code_challenge_methods_supported: ['S256'] });
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata="http://lexc.test/.well-known/oauth-protected-resource"');
  });

  it('registers public clients with https or localhost redirect URIs only', async () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:8080/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    expect((await register(['http://evil.example/cb'])).status).toBe(400);
    const ok = await register();
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ client_name: 'Claude Desktop', token_endpoint_auth_method: 'none', redirect_uris: [REDIRECT] });
  });

  it('signs in, asks for consent, and exchanges a PKCE code for tokens that work on /mcp', async () => {
    const { client_id: clientId } = await (await register()).json();
    const { challenge } = pkce();
    // Not signed in: off to the dashboard's sign-in, coming back here.
    const anon = await fetch(base + authorizeUrl(clientId, challenge), { redirect: 'manual' });
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toMatch(/^\/api\/auth\/login\?returnTo=%2Foauth%2Fauthorize/);
    // An unknown redirect URI is shown as an error, never redirected to.
    expect((await fetch(base + authorizeUrl(clientId, challenge, { redirect_uri: 'http://127.0.0.1:1/other' }), { headers: { 'x-test-user': 'tanvir' }, redirect: 'manual' })).status).toBe(400);
    // PKCE is required.
    const plain = await fetch(base + authorizeUrl(clientId, challenge, { code_challenge_method: 'plain' }), { headers: { 'x-test-user': 'tanvir' }, redirect: 'manual' });
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const { html, location } = await consent('tanvir', clientId, challenge);
    expect(html).toContain('Allow Claude Desktop?');
    expect(html).toContain('FinHealth AI (engineer)');
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe('http://lexc.test');
    const code = location.searchParams.get('code')!;

    expect((await token({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' })).body.error).toBe('invalid_grant');
    // That attempt used the code: start again.
    const again = pkce();
    const code2 = (await consent('tanvir', clientId, again.challenge)).location.searchParams.get('code')!;
    const issued = await token({ grant_type: 'authorization_code', client_id: clientId, code: code2, redirect_uri: REDIRECT, code_verifier: again.verifier });
    expect(issued.status).toBe(200);
    expect(issued.cache).toBe('no-store');
    expect(issued.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(await ping(issued.body.access_token)).toBe(200);
    // The token acts as Tanvir in FinHealth, and shows in his token list.
    const tanvir = store.getUserBySub('tanvir')!;
    expect(store.listApiTokens(ws, tanvir.id).map((t) => t.name)).toContain('OAuth: Claude Desktop');

    // Refresh rotates: new tokens work, the old refresh and access tokens don't.
    const refreshed = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: issued.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(await ping(refreshed.body.access_token)).toBe(200);
    expect(await ping(issued.body.access_token)).toBe(401);
    expect((await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: issued.body.refresh_token })).body.error).toBe('invalid_grant');

    // Reusing the code revokes what it produced.
    expect((await token({ grant_type: 'authorization_code', client_id: clientId, code: code2, redirect_uri: REDIRECT, code_verifier: again.verifier })).body.error).toBe('invalid_grant');
    expect(await ping(refreshed.body.access_token)).toBe(401);
    expect((await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshed.body.refresh_token })).body.error).toBe('invalid_grant');
  });

  it('honours Deny, refuses forged forms, and gives non-members no workspace', async () => {
    const { client_id: clientId } = await (await register()).json();
    const { challenge } = pkce();
    expect((await consent('tanvir', clientId, challenge, 'deny')).location.searchParams.get('error')).toBe('access_denied');

    const forged = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'x-test-user': 'tanvir', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: 'xyz', form_token: 'forged', workspace_id: ws, decision: 'allow' }),
      redirect: 'manual',
    });
    expect(forged.status).toBe(403);

    const outsider = await fetch(base + authorizeUrl(clientId, challenge), { headers: { 'x-test-user': 'outsider' }, redirect: 'manual' });
    expect(outsider.status).toBe(403);
    expect(await outsider.text()).toContain('not a member of any LexCompiler workspace');
    expect((await token({ grant_type: 'password', client_id: clientId })).body.error).toBe('unsupported_grant_type');
    expect((await token({ grant_type: 'authorization_code', client_id: 'lexc_client_unknown', code: 'x' })).status).toBe(401);
  });
});
