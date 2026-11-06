import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import type { Principal } from '../auth/oidc.js';
import type { Db } from '../db/index.js';
import type { ProductStore } from '../product/store.js';
import { sha256Hex } from '../util/hash.js';

/**
 * OAuth 2.1 for the workspace MCP endpoint (product guide, Phase 4a item 2, "add OAuth later"):
 * protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic
 * client registration (RFC 7591), and the authorization-code flow with PKCE (S256 only).
 *
 * The person signs in as for the dashboard (OIDC), picks one of their workspaces on a consent
 * page, and the client gets a one-hour access token (a personal access token acting with their
 * role, so /mcp needs nothing new) and a refresh token that rotates on every use. Reusing an
 * authorization code revokes everything issued from it.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CLIENT_PREFIX = 'lexc_client_';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const random = () => crypto.randomBytes(32).toString('base64url');
const s256 = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
}

/** OAuth clients, codes and refresh tokens; only hashes of codes and tokens are stored. */
export class OAuthStore {
  constructor(private readonly db: Db) {}

  registerClient(name: string, redirectUris: string[]): OAuthClient {
    const clientId = CLIENT_PREFIX + crypto.randomBytes(16).toString('base64url');
    this.db.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, JSON.stringify(redirectUris), nowIso());
    return { clientId, name, redirectUris };
  }

  getClient(clientId: string): OAuthClient | undefined {
    const r = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as Row | undefined;
    return r ? { clientId: String(r.client_id), name: String(r.name), redirectUris: JSON.parse(String(r.redirect_uris_json)) as string[] } : undefined;
  }

  createCode(input: { clientId: string; userId: string; workspaceId: string; redirectUri: string; codeChallenge: string }): string {
    const code = random();
    this.db
      .prepare('INSERT INTO oauth_codes (code_sha256, client_id, user_id, workspace_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha256Hex(code), input.clientId, input.userId, input.workspaceId, input.redirectUri, input.codeChallenge, new Date(Date.now() + CODE_TTL_MS).toISOString());
    return code;
  }

  /** Marks a code used and returns it; a code used before comes back with `reused` so its tokens can be revoked. */
  takeCode(code: string): { codeSha256: string; clientId: string; userId: string; workspaceId: string; redirectUri: string; codeChallenge: string; expired: boolean; reused: boolean } | undefined {
    const codeSha256 = sha256Hex(code);
    const r = this.db.prepare('SELECT * FROM oauth_codes WHERE code_sha256 = ?').get(codeSha256) as Row | undefined;
    if (!r) return undefined;
    const reused = r.used_at != null;
    if (!reused) this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_sha256 = ?').run(nowIso(), codeSha256);
    return {
      codeSha256,
      clientId: String(r.client_id),
      userId: String(r.user_id),
      workspaceId: String(r.workspace_id),
      redirectUri: String(r.redirect_uri),
      codeChallenge: String(r.code_challenge),
      expired: String(r.expires_at) <= nowIso(),
      reused,
    };
  }

  createRefreshToken(input: { clientId: string; userId: string; workspaceId: string; codeSha256: string; accessTokenId: string }): string {
    const token = random();
    this.db
      .prepare('INSERT INTO oauth_refresh_tokens (token_sha256, client_id, user_id, workspace_id, code_sha256, access_token_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256Hex(token), input.clientId, input.userId, input.workspaceId, input.codeSha256, input.accessTokenId, nowIso(), new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString());
    return token;
  }

  getRefreshToken(token: string): { tokenSha256: string; clientId: string; userId: string; workspaceId: string; codeSha256: string; accessTokenId: string | null; usable: boolean } | undefined {
    const r = this.db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_sha256 = ?').get(sha256Hex(token)) as Row | undefined;
    if (!r) return undefined;
    return {
      tokenSha256: String(r.token_sha256),
      clientId: String(r.client_id),
      userId: String(r.user_id),
      workspaceId: String(r.workspace_id),
      codeSha256: String(r.code_sha256),
      accessTokenId: r.access_token_id == null ? null : String(r.access_token_id),
      usable: r.revoked_at == null && String(r.expires_at) > nowIso(),
    };
  }

  revokeRefreshToken(tokenSha256: string): void {
    this.db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_sha256 = ?').run(nowIso(), tokenSha256);
  }

  /** Every refresh token issued from a code, with its access token id (for revoking on code reuse). */
  issuedFromCode(codeSha256: string): Array<{ tokenSha256: string; accessTokenId: string | null }> {
    return (this.db.prepare('SELECT token_sha256, access_token_id FROM oauth_refresh_tokens WHERE code_sha256 = ?').all(codeSha256) as Row[]).map((r) => ({
      tokenSha256: String(r.token_sha256),
      accessTokenId: r.access_token_id == null ? null : String(r.access_token_id),
    }));
  }
}

/** https, or http on this machine only (desktop clients listen on localhost). */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface OAuthOptions {
  store: ProductStore;
  db: Db;
  publicUrl: string;
  /** The signed-in person (dashboard sign-in), or null. */
  principal: (req: Request) => Promise<Principal | null>;
  /** Where to sign in, returning to `returnTo`; null when sign-in isn't configured. */
  loginUrl: (returnTo: string) => string | null;
}

/** Mount at the app root, outside the /api guard. */
export function createOAuthRouter(options: OAuthOptions) {
  const r = express.Router();
  const oauth = new OAuthStore(options.db);
  const { store } = options;
  const base = options.publicUrl.replace(/\/+$/, '');
  // Binds a consent form to the person and the request it was shown for (CSRF), for this process's life.
  const formSecret = crypto.randomBytes(32);
  const formToken = (sub: string, fields: string) => crypto.createHmac('sha256', formSecret).update(`${sub}\n${fields}`).digest('base64url');

  const resourceMetadata = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_name: 'LexCompiler',
  };
  r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(resourceMetadata));
  r.get('/.well-known/oauth-authorization-server', (_req, res) =>
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    })
  );

  /** Dynamic client registration: { client_name, redirect_uris }. Public clients only. */
  r.post('/oauth/register', express.json({ limit: '16kb' }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirectUri)) {
      return void res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs, or http URLs on localhost' });
    }
    const name = String(body.client_name ?? 'MCP client').slice(0, 100);
    const client = oauth.registerClient(name, uris);
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  /** Errors that may go back to a checked redirect URI; anything earlier is shown, never redirected. */
  const redirectWith = (res: Response, redirectUri: string, params: Record<string, string | undefined>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  };
  const page = (res: Response, status: number, title: string, body: string) =>
    res
      .status(status)
      .setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
      .setHeader('X-Frame-Options', 'DENY')
      .type('html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}select{font:inherit}</style></head><body>${body}</body></html>`
      );

  const checkRequest = (q: Record<string, unknown>) => {
    const client = oauth.getClient(String(q.client_id ?? ''));
    if (!client) return { error: 'Unknown client. Register it first (POST /oauth/register).' } as const;
    const redirectUri = String(q.redirect_uri ?? '');
    if (!client.redirectUris.includes(redirectUri)) return { error: 'This redirect URI is not registered for the client.' } as const;
    return { client, redirectUri } as const;
  };

  r.get('/oauth/authorize', async (req, res) => {
    const q = req.query as Record<string, string>;
    const checked = checkRequest(q);
    if ('error' in checked) return void page(res, 400, 'Sign-in request refused', `<h1>Sign-in request refused</h1><p>${esc(checked.error!)}</p>`);
    const { client, redirectUri } = checked;
    const state = q.state ? { state: String(q.state) } : {};
    if (q.response_type !== 'code') return redirectWith(res, redirectUri, { error: 'unsupported_response_type', ...state });
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(q.code_challenge ?? ''))) {
      return redirectWith(res, redirectUri, { error: 'invalid_request', error_description: 'PKCE with S256 is required', ...state });
    }
    const who = await options.principal(req);
    if (!who) {
      const login = options.loginUrl(req.originalUrl);
      if (login) return void res.redirect(302, login);
      return void page(res, 401, 'Sign in required', '<h1>Sign in required</h1><p>This server has no sign-in configured. Use a personal access token from Settings instead.</p>');
    }
    const user = store.getUserBySub(who.sub);
    const workspaces = user ? store.listWorkspacesForUser(user.id) : [];
    if (workspaces.length === 0) {
      return void page(res, 403, 'No workspace', `<h1>No workspace</h1><p>${esc(who.email ?? who.sub)} is not a member of any LexCompiler workspace, so ${esc(client.name)} can't act for you.</p>`);
    }
    const fields = ['client_id', 'redirect_uri', 'code_challenge', 'state'].map((k) => `${k}=${q[k] ?? ''}`).join('&');
    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
    page(
      res,
      200,
      `Allow ${client.name}?`,
      `<h1>Allow ${esc(client.name)}?</h1>
<p><strong>${esc(client.name)}</strong> wants to use LexCompiler's tools as <strong>${esc(who.email ?? who.name ?? who.sub)}</strong>, with your role in the workspace you pick: list rules, check changes, explain findings, suggest fixes, search obligations and request exceptions. It can't approve anything.</p>
<p>It will return to <code>${esc(new URL(redirectUri).origin)}</code>. Access lasts an hour and renews until you revoke it in Settings.</p>
<form method="post" action="/oauth/authorize">
${hidden('client_id', client.clientId)}${hidden('redirect_uri', redirectUri)}${hidden('code_challenge', String(q.code_challenge))}${hidden('state', String(q.state ?? ''))}${hidden('form_token', formToken(who.sub, fields))}
<p><label>Workspace <select name="workspace_id">${workspaces.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} (${esc(w.role)})</option>`).join('')}</select></label></p>
<p><button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></p>
</form>`
    );
  });

  r.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const checked = checkRequest(b);
    if ('error' in checked) return void page(res, 400, 'Sign-in request refused', `<h1>Sign-in request refused</h1><p>${esc(checked.error!)}</p>`);
    const { client, redirectUri } = checked;
    const who = await options.principal(req);
    const fields = ['client_id', 'redirect_uri', 'code_challenge', 'state'].map((k) => `${k}=${b[k] ?? ''}`).join('&');
    const expected = who ? formToken(who.sub, fields) : '';
    if (!who || !b.form_token || b.form_token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(b.form_token), Buffer.from(expected))) {
      return void page(res, 403, 'Request expired', '<h1>Request expired</h1><p>Start again from your MCP client.</p>');
    }
    const state = b.state ? { state: b.state } : {};
    if (b.decision !== 'allow') return redirectWith(res, redirectUri, { error: 'access_denied', ...state });
    const user = store.getUserBySub(who.sub);
    if (!user || !store.roleOf(String(b.workspace_id), user.id)) return redirectWith(res, redirectUri, { error: 'access_denied', ...state });
    const code = oauth.createCode({ clientId: client.clientId, userId: user.id, workspaceId: String(b.workspace_id), redirectUri, codeChallenge: String(b.code_challenge) });
    redirectWith(res, redirectUri, { code, ...state, iss: base });
  });

  const issue = (res: Response, input: { clientId: string; clientName: string; userId: string; workspaceId: string; codeSha256: string }) => {
    const access = store.createShortLivedApiToken(input.workspaceId, input.userId, `OAuth: ${input.clientName}`, ACCESS_TOKEN_TTL_MS);
    const refresh = oauth.createRefreshToken({ clientId: input.clientId, userId: input.userId, workspaceId: input.workspaceId, codeSha256: input.codeSha256, accessTokenId: access.record.id });
    res.json({ access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: refresh, scope: 'mcp' });
  };
  const tokenError = (res: Response, error: string, description: string) => res.status(400).json({ error, error_description: description });

  r.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const b = (req.body ?? {}) as Record<string, string>;
    const client = oauth.getClient(String(b.client_id ?? ''));
    if (!client) return void res.status(401).json({ error: 'invalid_client' });
    try {
      if (b.grant_type === 'authorization_code') {
        const code = oauth.takeCode(String(b.code ?? ''));
        if (!code || code.clientId !== client.clientId) return void tokenError(res, 'invalid_grant', 'unknown code');
        if (code.reused) {
          // A code used twice may have leaked: revoke everything it produced.
          for (const t of oauth.issuedFromCode(code.codeSha256)) {
            oauth.revokeRefreshToken(t.tokenSha256);
            if (t.accessTokenId) store.revokeApiTokenById(t.accessTokenId);
          }
          return void tokenError(res, 'invalid_grant', 'this code was already used');
        }
        if (code.expired) return void tokenError(res, 'invalid_grant', 'the code expired');
        if (String(b.redirect_uri ?? '') !== code.redirectUri) return void tokenError(res, 'invalid_grant', 'redirect_uri does not match');
        if (!b.code_verifier || s256(String(b.code_verifier)) !== code.codeChallenge) return void tokenError(res, 'invalid_grant', 'code_verifier does not match');
        if (!store.roleOf(code.workspaceId, code.userId)) return void tokenError(res, 'invalid_grant', 'no longer a member of the workspace');
        return void issue(res, { clientId: client.clientId, clientName: client.name, userId: code.userId, workspaceId: code.workspaceId, codeSha256: code.codeSha256 });
      }
      if (b.grant_type === 'refresh_token') {
        const old = oauth.getRefreshToken(String(b.refresh_token ?? ''));
        if (!old || old.clientId !== client.clientId || !old.usable) return void tokenError(res, 'invalid_grant', 'unknown, expired or revoked refresh token');
        // Rotation: the old refresh token and its access token stop working.
        oauth.revokeRefreshToken(old.tokenSha256);
        if (old.accessTokenId) store.revokeApiTokenById(old.accessTokenId);
        if (!store.roleOf(old.workspaceId, old.userId)) return void tokenError(res, 'invalid_grant', 'no longer a member of the workspace');
        return void issue(res, { clientId: client.clientId, clientName: client.name, userId: old.userId, workspaceId: old.workspaceId, codeSha256: old.codeSha256 });
      }
      tokenError(res, 'unsupported_grant_type', 'use authorization_code or refresh_token');
    } catch (err) {
      res.status(500).json({ error: 'server_error', error_description: err instanceof Error ? err.message : String(err) });
    }
  });

  return r;
}
