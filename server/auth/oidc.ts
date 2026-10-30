import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/** Global role from the identity provider. Project roles come from project membership. */
export type GlobalRole = 'admin' | 'member';

export interface Principal {
  sub: string;
  email?: string;
  /** The provider's `email_verified` claim. Invitations are only matched on verified emails. */
  emailVerified?: boolean;
  name?: string;
  globalRole: GlobalRole;
  /** How the caller authenticated. */
  via: 'api-token' | 'oidc-bearer' | 'oidc-session' | 'password-session' | 'loopback';
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Accepted `aud` values for bearer tokens (defaults to the client id). */
  audience: string[];
  rolesClaim: string;
  adminRole: string;
  scopes: string;
  /** Use Secure cookies (set when the public URL is https). */
  secureCookies: boolean;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.LEXCOMPILER_OIDC_ISSUER?.trim();
  const clientId = env.LEXCOMPILER_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  const redirectUri = env.LEXCOMPILER_OIDC_REDIRECT_URI?.trim() || `http://localhost:${env.PORT || 3001}/api/auth/callback`;
  return {
    issuer: issuer.replace(/\/$/, ''),
    clientId,
    clientSecret: env.LEXCOMPILER_OIDC_CLIENT_SECRET?.trim() || undefined,
    redirectUri,
    audience: (env.LEXCOMPILER_OIDC_AUDIENCE || clientId).split(',').map((s) => s.trim()).filter(Boolean),
    rolesClaim: env.LEXCOMPILER_OIDC_ROLES_CLAIM || 'roles',
    adminRole: env.LEXCOMPILER_OIDC_ADMIN_ROLE || 'lexcompiler-admin',
    scopes: env.LEXCOMPILER_OIDC_SCOPES || 'openid email profile',
    secureCookies: redirectUri.startsWith('https://'),
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const SESSION_COOKIE = 'lexc_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString('base64url');

/** Where signed-in sessions live. The server uses the database, so sessions survive restarts. */
export interface SessionStore {
  create(principal: Principal, ttlMs: number): string;
  get(sessionId: string): Principal | null;
  delete(sessionId: string): void;
}

/** In-process sessions, for tests and single-process tools. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { principal: Principal; expires: number }>();

  create(principal: Principal, ttlMs: number): string {
    const id = b64url(crypto.randomBytes(32));
    this.sessions.set(id, { principal, expires: Date.now() + ttlMs });
    return id;
  }

  get(sessionId: string): Principal | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s.principal;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * OpenID Connect relying party: authorization-code flow with PKCE for the browser (server-side
 * sessions in an HttpOnly cookie), and bearer-token verification (signature via the issuer's
 * JWKS, issuer, audience and expiry) for API clients.
 */
export class OidcProvider {
  private discovery: Promise<Discovery> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private readonly pending = new Map<string, { verifier: string; nonce: string; returnTo: string; expires: number }>();

  constructor(
    readonly config: OidcConfig,
    private readonly sessions: SessionStore = new MemorySessionStore()
  ) {}

  async metadata(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await fetch(`${this.config.issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
      const d = (await res.json()) as Discovery;
      if (d.issuer.replace(/\/$/, '') !== this.config.issuer) throw new Error(`OIDC issuer mismatch: ${d.issuer}`);
      return d;
    })();
    this.discovery.catch(() => (this.discovery = null));
    return this.discovery;
  }

  private async keys() {
    if (!this.jwks) {
      const { jwks_uri } = await this.metadata();
      this.jwks = createRemoteJWKSet(new URL(jwks_uri));
    }
    return this.jwks;
  }

  private principalFrom(payload: JWTPayload, via: Principal['via']): Principal {
    const claim = payload[this.config.rolesClaim];
    const roles = Array.isArray(claim) ? claim.map(String) : typeof claim === 'string' ? claim.split(/[ ,]+/) : [];
    return {
      sub: String(payload.sub),
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      globalRole: roles.includes(this.config.adminRole) ? 'admin' : 'member',
      via,
    };
  }

  /** Verifies a JWT issued by the provider (signature, iss, aud, exp, nbf). */
  async verify(token: string, opts: { audience?: string[]; nonce?: string } = {}): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, await this.keys(), {
      issuer: (await this.metadata()).issuer,
      audience: opts.audience || this.config.audience,
      clockTolerance: 30,
    });
    if (!payload.sub) throw new Error('token has no subject');
    if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new Error('nonce mismatch');
    return payload;
  }

  async principalFromBearer(token: string): Promise<Principal | null> {
    try {
      return this.principalFrom(await this.verify(token), 'oidc-bearer');
    } catch {
      return null;
    }
  }

  /** Starts a login: returns the provider URL to redirect the browser to. */
  async beginLogin(returnTo = '/'): Promise<string> {
    const d = await this.metadata();
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const nonce = b64url(crypto.randomBytes(16));
    this.pending.set(state, { verifier, nonce, returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/', expires: now + LOGIN_TTL_MS });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      state,
      nonce,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** Completes a login: exchanges the code, verifies the ID token, and opens a session. */
  async completeLogin(params: { code?: string; state?: string; error?: string }): Promise<{ sessionId: string; principal: Principal; returnTo: string }> {
    if (params.error) throw new Error(`identity provider returned ${params.error}`);
    const pending = params.state ? this.pending.get(params.state) : undefined;
    if (!pending || pending.expires < Date.now() || !params.code) throw new Error('unknown or expired login state');
    this.pending.delete(params.state!);
    const d = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: pending.verifier,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.config.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`;
    const res = await fetch(d.token_endpoint, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('token response has no id_token');
    const payload = await this.verify(tokens.id_token, { audience: [this.config.clientId], nonce: pending.nonce });
    const principal = this.principalFrom(payload, 'oidc-session');
    const sessionId = this.sessions.create(principal, SESSION_TTL_MS);
    return { sessionId, principal, returnTo: pending.returnTo };
  }

  principalFromSession(sessionId: string | undefined): Principal | null {
    if (!sessionId) return null;
    return this.sessions.get(sessionId);
  }

  endSession(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  sessionCookie(sessionId: string): string {
    return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${this.config.secureCookies ? '; Secure' : ''}`;
  }

  clearedCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.secureCookies ? '; Secure' : ''}`;
  }

  static sessionIdFromCookies(cookieHeader: string | undefined): string | undefined {
    for (const part of (cookieHeader || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === SESSION_COOKIE) return v.join('=');
    }
    return undefined;
  }
}
