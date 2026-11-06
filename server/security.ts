import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Header every LexCompiler API client must send. Browsers cannot attach a custom
 * header to a cross-origin request without a CORS preflight, which the origin
 * allowlist rejects, so this blocks drive-by requests from other web pages
 * (including `<img>`/form GETs that carry no Origin header).
 */
export const CLIENT_HEADER = 'x-lexcompiler-client';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

export interface ServerSecurityConfig {
  host: string;
  port: number;
  apiToken: string | null;
  allowedOrigins: string[];
  allowedHosts: string[];
  runtimeSandboxEnabled: boolean;
  /** OIDC sign-in is configured (LEXCOMPILER_OIDC_ISSUER + LEXCOMPILER_OIDC_CLIENT_ID). */
  oidcEnabled: boolean;
  /** Email and password sign-in (LEXCOMPILER_SIGN_IN=password). Like OIDC, every request then needs a signed-in person. */
  passwordSignIn: boolean;
  /** Project role every signed-in user has on the default (single-repository) project. */
  defaultProjectRole: 'viewer' | 'editor' | 'owner' | 'none';
}

function splitList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export function resolveServerSecurityConfig(env: NodeJS.ProcessEnv = process.env): ServerSecurityConfig {
  const port = env.PORT ? parseInt(env.PORT, 10) : 3001;
  const extraOrigins = splitList(env.LEXCOMPILER_ALLOWED_ORIGINS);
  // The address people use (LEXCOMPILER_PUBLIC_URL) is always an allowed browser origin.
  let publicOrigin: string | null = null;
  try {
    publicOrigin = env.LEXCOMPILER_PUBLIC_URL ? new URL(env.LEXCOMPILER_PUBLIC_URL).origin : null;
  } catch {
    publicOrigin = null;
  }
  const origins = extraOrigins.length > 0 ? extraOrigins : DEFAULT_ALLOWED_ORIGINS;
  return {
    host: env.HOST || '127.0.0.1',
    port,
    apiToken: env.LEXCOMPILER_API_TOKEN?.trim() || null,
    allowedOrigins: publicOrigin && !origins.includes(publicOrigin) ? [...origins, publicOrigin] : origins,
    allowedHosts: splitList(env.LEXCOMPILER_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    runtimeSandboxEnabled: env.LEXCOMPILER_ENABLE_RUNTIME_SANDBOX === '1',
    oidcEnabled: Boolean(env.LEXCOMPILER_OIDC_ISSUER?.trim() && env.LEXCOMPILER_OIDC_CLIENT_ID?.trim()),
    passwordSignIn: env.LEXCOMPILER_SIGN_IN === 'password',
    defaultProjectRole: (['viewer', 'editor', 'owner', 'none'] as const).find((r) => r === env.LEXCOMPILER_DEFAULT_PROJECT_ROLE) || 'viewer',
  };
}

/**
 * Refuses to expose the API beyond loopback without a token: every endpoint can
 * rewrite target-repo files and trigger Git commits.
 */
export function assertSafeBindConfig(config: ServerSecurityConfig): void {
  // The runtime sandbox executes repository code; never on a server others can reach.
  if (!isLoopbackHostname(config.host) && config.runtimeSandboxEnabled) {
    throw new Error(`Refusing to listen on non-loopback host "${config.host}" with LEXCOMPILER_ENABLE_RUNTIME_SANDBOX=1. Turn the runtime sandbox off on a public server.`);
  }
  if (!isLoopbackHostname(config.host) && !config.apiToken && !config.oidcEnabled && !config.passwordSignIn) {
    throw new Error(
      `Refusing to listen on non-loopback host "${config.host}" without LEXCOMPILER_API_TOKEN or OIDC. ` +
        'Set LEXCOMPILER_API_TOKEN or LEXCOMPILER_OIDC_ISSUER/LEXCOMPILER_OIDC_CLIENT_ID, or bind to 127.0.0.1.'
    );
  }
}

function hostnameFromHostHeader(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) {
    return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  }
  return hostHeader.split(':')[0].toLowerCase();
}

/**
 * Per-client rate limit (product guide, Phase 7): at most `max` requests per `windowMs` for each
 * key (the client IP by default; set `trust proxy` behind a reverse proxy so req.ip is the
 * client's). Over the limit: 429 with Retry-After.
 */
export function rateLimit(options: { windowMs: number; max: number; name: string; key?: (req: Request) => string }) {
  const hits = new Map<string, number[]>();
  let sweep = Date.now();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // Drop idle clients now and then, so the map can't grow without bound.
    if (now - sweep > options.windowMs) {
      for (const [k, times] of hits) if (times[times.length - 1] <= now - options.windowMs) hits.delete(k);
      sweep = now;
    }
    const key = options.key ? options.key(req) : req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
    if (recent.length >= options.max) {
      hits.set(key, recent);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((options.windowMs - (now - recent[0])) / 1000))));
      res.status(429).json({ error: `Too many requests (${options.name}): at most ${options.max} per ${Math.round(options.windowMs / 1000)} seconds.` });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

/** The `trust proxy` setting from LEXCOMPILER_TRUST_PROXY: a hop count, "true", or a list such as "loopback". */
export function trustProxySetting(value: string | undefined): boolean | number | string | undefined {
  const v = value?.trim();
  if (!v || v === 'false' || v === '0') return undefined;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * HTTPS only (Phase 7): when the public URL is https and requests come through a trusted proxy,
 * plain-HTTP requests are redirected and responses carry HSTS. /api/health stays reachable over
 * HTTP for the container's health check.
 */
export function httpsOnly(publicUrl: string) {
  const enabled = publicUrl.startsWith('https://');
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || req.path === '/api/health') return next();
    if (!req.secure) {
      res.redirect(308, `${publicUrl}${req.originalUrl}`);
      return;
    }
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isOriginAllowed(config: ServerSecurityConfig, origin: string | undefined): boolean {
  return !origin || config.allowedOrigins.includes(origin);
}

/**
 * Guards every `/api` route except `/api/health`:
 * - Origin, when present, must be in the allowlist.
 * - With LEXCOMPILER_API_TOKEN set, `Authorization: Bearer <token>` is required.
 * - Without a token, the Host header must be loopback (or allowlisted) to defeat
 *   DNS rebinding, and the client header must be present.
 */
const PUBLIC_AUTH_PATHS = new Set(['/auth/config', '/auth/login', '/auth/callback', '/auth/password', '/auth/logout']);
const ROLE_RANK = { none: 0, viewer: 1, editor: 2, owner: 3 } as const;

/** Resolves the caller from a bearer token or session cookie (OIDC); null when unauthenticated. */
export type Authenticator = (req: Request) => Promise<import('./auth/oidc.js').Principal | null>;

/** Paths that check workspace roles themselves; the default-project role does not apply. */
function isWorkspaceScopedPath(p: string): boolean {
  return p.startsWith('/workspaces') || p.startsWith('/library/') || p.startsWith('/auth/');
}

export function createApiGuard(config: ServerSecurityConfig, authenticate?: Authenticator) {
  // With sign-in on, every request needs a signed-in person (or the API token); requests from this
  // machine get no special rights, because a tunnel makes public requests arrive from loopback.
  const signIn = config.oidcEnabled || config.passwordSignIn;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/health' || req.method === 'OPTIONS' || (signIn && PUBLIC_AUTH_PATHS.has(req.path))) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (!isOriginAllowed(config, origin)) {
      res.status(403).json({ error: `Origin "${origin}" is not allowed (LEXCOMPILER_ALLOWED_ORIGINS).` });
      return;
    }

    if (signIn && authenticate) {
      authenticate(req)
        .then((principal) => {
          if (!principal) {
            res.status(401).json({ error: 'Sign in required.', authRequired: true, loginUrl: config.oidcEnabled ? '/api/auth/login' : '/login' });
            return;
          }
          // Cookie sessions also need the client header on writes (CSRF: no custom header cross-site).
          if ((principal.via === 'oidc-session' || principal.via === 'password-session') && req.method !== 'GET' && !req.headers[CLIENT_HEADER]) {
            res.status(403).json({ error: `Missing required "${CLIENT_HEADER}" request header.` });
            return;
          }
          res.locals.principal = principal;
          // Single-repository endpoints act on the default project.
          if (!isWorkspaceScopedPath(req.path) && principal.globalRole !== 'admin') {
            const need = req.method === 'GET' ? ROLE_RANK.viewer : ROLE_RANK.editor;
            if (ROLE_RANK[config.defaultProjectRole] < need) {
              res.status(403).json({ error: `Your role on the default project (${config.defaultProjectRole}) does not allow this request.` });
              return;
            }
          }
          next();
        })
        .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (config.apiToken) {
      const auth = req.headers.authorization || '';
      const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
      if (!provided || !tokensMatch(config.apiToken, provided)) {
        res.status(401).json({ error: 'Missing or invalid API token.', authRequired: true });
        return;
      }
      res.locals.principal = { sub: 'api-token', globalRole: 'admin', via: 'api-token' };
      next();
      return;
    }

    const hostname = hostnameFromHostHeader(req.headers.host);
    if (!isLoopbackHostname(hostname) && !config.allowedHosts.includes(hostname)) {
      res.status(403).json({ error: `Host "${hostname}" is not allowed (LEXCOMPILER_ALLOWED_HOSTS).` });
      return;
    }

    if (!req.headers[CLIENT_HEADER]) {
      res.status(403).json({ error: `Missing required "${CLIENT_HEADER}" request header.` });
      return;
    }
    res.locals.principal = { sub: 'local', globalRole: 'admin', via: 'loopback' };

    next();
  };
}
