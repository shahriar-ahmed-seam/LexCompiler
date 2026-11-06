import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import type { GitHubAppCredentials } from './credentials.js';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface GitHubUrls {
  /** REST API, e.g. https://api.github.com */
  apiUrl: string;
  /** Web pages and OAuth, e.g. https://github.com */
  webUrl: string;
}

export function githubUrls(env: NodeJS.ProcessEnv = process.env): GitHubUrls {
  return {
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    webUrl: (env.LEXCOMPILER_GITHUB_WEB_URL || 'https://github.com').replace(/\/+$/, ''),
  };
}

const API_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'LexCompiler' };
/** Repository archives over this size are refused. */
export const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

export interface GitHubRepoSummary {
  id: number;
  fullName: string;
  defaultBranch: string;
}

export interface GitHubAppOptions {
  /** Waits before each retry of a safe-to-repeat call. Default: 0.5 s, 2 s, 5 s. */
  retryDelaysMs?: number[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Responses worth retrying: rate limiting and GitHub's transient server errors. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A GitHub App: authenticates as the app (JWT) and as its installations (one-hour tokens). */
export class GitHubApp {
  private readonly key: crypto.KeyObject;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();
  private readonly retryDelaysMs: number[];

  constructor(
    readonly credentials: GitHubAppCredentials,
    readonly urls: GitHubUrls = githubUrls(),
    private readonly fetchImpl: typeof fetch = fetch,
    options: GitHubAppOptions = {}
  ) {
    this.key = crypto.createPrivateKey(credentials.privateKeyPem);
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 2000, 5000];
  }

  /**
   * Runs `attempt` again after network errors and retryable statuses. Only for calls that are safe
   * to repeat: GETs, PATCHes that set the same values, and token requests. Creating a check run is
   * not retried here; a lost response would leave a duplicate run.
   */
  private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (err) {
        const retryable = !(err instanceof GitHubApiError) || RETRYABLE_STATUS.has(err.status);
        if (!retryable || i >= this.retryDelaysMs.length) throw err;
        await sleep(this.retryDelaysMs[i]);
      }
    }
  }

  /** A JWT that authenticates as the app itself. GitHub accepts at most 10 minutes. */
  appJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(this.credentials.appId)
      .sign(this.key);
  }

  private async call<T>(token: string, method: string, route: string, body?: unknown, options: { retry?: boolean } = {}): Promise<T> {
    const retry = options.retry ?? (method === 'GET' || method === 'PATCH');
    return retry ? this.withRetries(() => this.callOnce<T>(token, method, route, body)) : this.callOnce<T>(token, method, route, body);
  }

  private async callOnce<T>(token: string, method: string, route: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.urls.apiUrl}${route}`, {
      method,
      headers: { ...API_HEADERS, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubApiError(`GitHub ${method} ${route.split('?')[0]} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Points the App's webhook at `url` (GET, then PATCH /app/hook/config as the app) unless it
   * already does. Returns the previous URL when it changed it, or null.
   */
  async syncWebhookUrl(url: string): Promise<string | null> {
    const jwt = await this.appJwt();
    const config = await this.call<{ url?: string }>(jwt, 'GET', '/app/hook/config');
    if (config.url === url) return null;
    await this.call(jwt, 'PATCH', '/app/hook/config', { url });
    return config.url ?? '';
  }

  /** Installation tokens last an hour. One is reused until five minutes before it expires; none is stored. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
    // Asking for a token twice is harmless, so this POST is retried.
    const data = await this.call<{ token: string; expires_at?: string }>(await this.appJwt(), 'POST', `/app/installations/${installationId}/access_tokens`, undefined, { retry: true });
    this.tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at || '') || Date.now() + 55 * 60 * 1000 });
    return data.token;
  }

  /** Calls the REST API as an installation. */
  async request<T = Record<string, unknown>>(installationId: number, method: string, route: string, body?: unknown): Promise<T> {
    return this.call<T>(await this.installationToken(installationId), method, route, body);
  }

  /** Downloads `owner/repo` at `sha` as a gzipped tarball (in memory), refusing archives over 200 MiB. Retried as a whole, including a connection lost mid-download. */
  async downloadTarball(installationId: number, fullName: string, sha: string): Promise<Buffer> {
    return this.withRetries(() => this.downloadTarballOnce(installationId, fullName, sha));
  }

  private async downloadTarballOnce(installationId: number, fullName: string, sha: string): Promise<Buffer> {
    const token = await this.installationToken(installationId);
    const res = await this.fetchImpl(`${this.urls.apiUrl}/repos/${fullName}/tarball/${encodeURIComponent(sha)}`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
      redirect: 'follow',
    });
    if (!res.ok || !res.body) throw new GitHubApiError(`GitHub tarball of ${fullName}@${sha} failed (${res.status})`, res.status);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_TARBALL_BYTES) throw new GitHubApiError(`the repository archive is ${declared} bytes; the limit is ${MAX_TARBALL_BYTES}`, 413);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TARBALL_BYTES) {
        await reader.cancel();
        throw new GitHubApiError(`the repository archive exceeds ${MAX_TARBALL_BYTES} bytes`, 413);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** Repositories an installation can access. */
  async installationRepositories(installationId: number): Promise<GitHubRepoSummary[]> {
    const out: GitHubRepoSummary[] = [];
    for (let page = 1; page <= 50; page++) {
      const data = await this.request<{ repositories?: Array<{ id: number; full_name: string; default_branch?: string }> }>(
        installationId,
        'GET',
        `/installation/repositories?per_page=100&page=${page}`
      );
      const items = data.repositories ?? [];
      out.push(...items.map((r) => ({ id: Number(r.id), fullName: String(r.full_name), defaultBranch: String(r.default_branch || 'main') })));
      if (items.length < 100) break;
    }
    return out;
  }

  /** Where an owner installs the app. GitHub passes `state` back to the setup URL. */
  installUrl(state: string): string | null {
    const slug = this.credentials.slug;
    return slug ? `${this.urls.webUrl}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}` : null;
  }

  /** True when the app can confirm which GitHub user installed it (OAuth client credentials). */
  canVerifyUsers(): boolean {
    return Boolean(this.credentials.clientId && this.credentials.clientSecret);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.credentials.clientId || '', redirect_uri: redirectUri, state });
    return `${this.urls.webUrl}/login/oauth/authorize?${q}`;
  }

  /** Exchanges a user authorization code (web flow) for a user access token. */
  async exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
    const { clientId, clientSecret } = this.credentials;
    if (!clientId || !clientSecret) throw new GitHubApiError('the GitHub App has no OAuth client credentials', 500);
    const res = await this.fetchImpl(`${this.urls.webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'LexCompiler' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new GitHubApiError(`GitHub authorization failed: ${data.error_description || data.error || res.status}`, 401);
    return data.access_token;
  }

  /** Installations of this app that a user (by user access token) can access. */
  async userInstallations(userToken: string): Promise<Array<{ id: number; accountLogin: string; accountType: string }>> {
    const out: Array<{ id: number; accountLogin: string; accountType: string }> = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.call<{ installations?: Array<{ id: number; account?: { login?: string; type?: string } }> }>(
        userToken,
        'GET',
        `/user/installations?per_page=100&page=${page}`
      );
      const items = data.installations ?? [];
      out.push(...items.map((i) => ({ id: Number(i.id), accountLogin: String(i.account?.login ?? ''), accountType: String(i.account?.type ?? 'User') })));
      if (items.length < 100) break;
    }
    return out;
  }
}

/** Completes the manifest flow: exchanges GitHub's temporary code for the new app's credentials. */
export async function convertAppManifest(
  code: string,
  urls: GitHubUrls = githubUrls(),
  fetchImpl: typeof fetch = fetch
): Promise<Omit<GitHubAppCredentials, 'source'>> {
  const res = await fetchImpl(`${urls.apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: API_HEADERS });
  const text = await res.text();
  if (!res.ok) throw new GitHubApiError(`GitHub manifest conversion failed (${res.status}): ${text.slice(0, 300)}`, res.status);
  const d = JSON.parse(text) as {
    id: number;
    slug?: string;
    name?: string;
    html_url?: string;
    pem: string;
    webhook_secret: string;
    client_id?: string;
    client_secret?: string;
  };
  return {
    appId: String(d.id),
    slug: d.slug ?? null,
    name: d.name ?? null,
    htmlUrl: d.html_url ?? null,
    privateKeyPem: d.pem,
    webhookSecret: d.webhook_secret,
    clientId: d.client_id ?? null,
    clientSecret: d.client_secret ?? null,
  };
}

function signatureMatches(secret: string, body: Buffer, header: string): boolean {
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('hex'), 'utf8');
  const provided = Buffer.from(header.slice('sha256='.length), 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/**
 * GitHub serialises webhook JSON with <, >, &, U+2028 and U+2029 escaped as \uXXXX. Relays that
 * parse and re-stringify the body (smee.io) write those characters literally. This restores
 * GitHub's bytes; it changes no JSON value, because these characters only occur inside strings.
 */
export function restoreGitHubJsonEscapes(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Checks GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the body) in constant time.
 * With `relayReencoded`, a body a relay re-stringified is also checked after restoring GitHub's
 * escaping. The HMAC still has to match, so this accepts nothing GitHub didn't sign.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined, options: { relayReencoded?: boolean } = {}): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  if (signatureMatches(secret, rawBody, header)) return true;
  if (!options.relayReencoded) return false;
  const restored = Buffer.from(restoreGitHubJsonEscapes(rawBody.toString('utf8')), 'utf8');
  return !restored.equals(rawBody) && signatureMatches(secret, restored, header);
}
