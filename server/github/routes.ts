import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { OidcProvider, type Principal, type SessionStore } from '../auth/oidc.js';
import type { JobQueue } from '../jobs/queue.js';
import type { ProductStore, User } from '../product/store.js';
import { isLoopbackHostname } from '../security.js';
import { convertAppManifest, type GitHubApp, type GitHubUrls } from './client.js';
import { saveGitHubAppCredentials, type GitHubAppCredentials } from './credentials.js';
import { enqueueScan } from './webhooks.js';

/** Who is signed in, for browser navigations (which can't carry custom headers). */
export interface BrowserAuth {
  principal(req: Request): Promise<Principal | null>;
  loginUrl(returnTo: string): string | null;
}

/**
 * The session cookie (OIDC or password sign-in) when sign-in is on; otherwise only requests from
 * this machine count, as the local administrator.
 */
export function createBrowserAuth(oidc: OidcProvider | null, options: { sessions?: SessionStore; signInRequired?: boolean } = {}): BrowserAuth {
  const signIn = Boolean(oidc) || Boolean(options.signInRequired);
  return {
    async principal(req) {
      const sid = OidcProvider.sessionIdFromCookies(req.headers.cookie);
      if (oidc) return oidc.principalFromSession(sid);
      if (sid && options.sessions) {
        const p = options.sessions.get(sid);
        if (p) return p;
      }
      if (signIn) return null;
      return isLoopbackRequest(req) ? { sub: 'local', globalRole: 'admin', via: 'loopback' } : null;
    },
    loginUrl: (returnTo) => (oidc ? `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}` : signIn ? `/login?returnTo=${encodeURIComponent(returnTo)}` : null),
  };
}

function isLoopbackRequest(req: Request): boolean {
  const remote = req.socket.remoteAddress || '';
  const fromThisMachine = remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  let host = '';
  try {
    host = new URL(`http://${req.headers.host || ''}`).hostname;
  } catch {
    return false;
  }
  return fromThisMachine && isLoopbackHostname(host);
}

export interface GitHubRouteDeps {
  store: ProductStore;
  queue: JobQueue;
  getApp: () => GitHubApp | null;
  onRegistered: (credentials: GitHubAppCredentials) => void;
  auth: BrowserAuth;
  publicUrl: string;
  urls: GitHubUrls;
  /** Where GitHub sends webhooks. Must be reachable from the internet (a relay such as smee.io when testing locally). */
  webhookUrl: string;
}

interface PendingLink {
  workspaceId: string;
  sub: string;
  expires: number;
  installationId?: number;
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const newState = () => crypto.randomBytes(24).toString('base64url');

const CSS = `body{margin:0;background:#0b0f19;color:#e5e7eb;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:40px auto;padding:0 20px}.brand{color:#fbbf24;font-weight:600;letter-spacing:.04em;margin:0}
h1{font-size:24px;margin:.2em 0 .8em}a{color:#93c5fd}code{background:#111827;padding:1px 5px;border-radius:4px}
button{background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:15px;cursor:pointer}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border-bottom:1px solid #1f2937;padding:6px 8px;text-align:left;vertical-align:top}
.warn{background:#3b2a07;border:1px solid #92400e;padding:10px 12px;border-radius:6px}.muted{color:#9ca3af}
.new{color:#fca5a5}.existing{color:#fcd34d}.waived{color:#93c5fd}`;

function sendPage(res: Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Type': 'text/html; charset=utf-8' })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · LexCompiler</title><style>${CSS}</style></head><body><main><p class="brand">LexCompiler</p><h1>${esc(title)}</h1>${body}</main></body></html>`
    );
}

/** Browser pages: register the GitHub App, install it, link it to a workspace, view a scan. */
export function createGitHubRoutes(deps: GitHubRouteDeps) {
  const r = express.Router();
  const { store, publicUrl } = deps;
  const callbackUrl = `${publicUrl}/github/oauth/callback`;
  const pendingRegistrations = new Map<string, number>();
  const pendingLinks = new Map<string, PendingLink>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, exp] of pendingRegistrations) if (exp < now) pendingRegistrations.delete(k);
    for (const [k, p] of pendingLinks) if (p.expires < now) pendingLinks.delete(k);
  };

  const signedIn = async (req: Request, res: Response): Promise<{ principal: Principal; user: User } | null> => {
    const principal = await deps.auth.principal(req);
    if (!principal) {
      const login = deps.auth.loginUrl(req.originalUrl);
      if (login) res.redirect(302, login);
      else sendPage(res, 403, 'Sign-in required', '<p>Open this page on the machine that runs LexCompiler, or configure OIDC sign-in.</p>');
      return null;
    }
    const user = store.getUserBySub(principal.sub) ?? store.upsertUser({ sub: principal.sub, email: principal.email, emailVerified: Boolean(principal.emailVerified), name: principal.name });
    return { principal, user };
  };
  const ownedWorkspaces = (principal: Principal, user: User) =>
    principal.globalRole === 'admin' ? store.listWorkspaces() : store.listWorkspacesForUser(user.id).filter((w) => w.role === 'owner');

  // ---------------------------------------------------------------- 1. register the app (manifest flow)

  r.get('/github/register', async (req, res) => {
    const who = await signedIn(req, res);
    if (!who) return;
    if (who.principal.globalRole !== 'admin') return sendPage(res, 403, 'Administrators only', '<p>Only a LexCompiler administrator can register the GitHub App.</p>');
    const existing = deps.getApp();
    if (existing) {
      const c = existing.credentials;
      return sendPage(res, 200, 'The GitHub App is registered', `<p><b>${esc(c.name || c.slug || `App ${c.appId}`)}</b> (app id ${esc(c.appId)}, from ${c.source === 'env' ? 'environment variables' : 'the data directory'}).</p><p><a href="/github/install">Install it on a repository →</a></p>`);
    }
    let webhookHost = '';
    try {
      webhookHost = new URL(deps.webhookUrl).hostname;
    } catch {
      webhookHost = '';
    }
    if (!webhookHost || isLoopbackHostname(webhookHost)) {
      return sendPage(
        res,
        409,
        'Set a public webhook URL first',
        `<p class="warn">GitHub can't deliver webhooks to <code>${esc(deps.webhookUrl)}</code>. Start a relay and point it at this server, then restart LexCompiler with <code>LEXCOMPILER_GITHUB_WEBHOOK_URL</code> set to the relay URL:</p><pre><code>npx smee-client --url https://smee.io/&lt;channel&gt; --target ${esc(publicUrl)}/api/github/webhooks</code></pre>`
      );
    }
    sweep();
    const state = newState();
    pendingRegistrations.set(state, Date.now() + 60 * 60 * 1000);
    const org = typeof req.query.org === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(req.query.org) ? req.query.org : null;
    const action = `${deps.urls.webUrl}/${org ? `organizations/${org}/` : ''}settings/apps/new?state=${encodeURIComponent(state)}`;
    const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim().slice(0, 34) : `LexCompiler ${crypto.randomBytes(2).toString('hex')}`;
    const manifest = {
      name,
      url: publicUrl,
      description: 'Checks pull requests against the contract and regulation rules your Legal team approves in LexCompiler.',
      hook_attributes: { url: deps.webhookUrl, active: true },
      redirect_url: `${publicUrl}/github/register/callback`,
      callback_urls: [callbackUrl],
      setup_url: `${publicUrl}/github/setup`,
      setup_on_update: true,
      public: false,
      default_permissions: { checks: 'write', contents: 'read', pull_requests: 'write', metadata: 'read' },
      default_events: ['pull_request', 'push', 'check_run', 'check_suite'],
    };
    sendPage(
      res,
      200,
      'Register the LexCompiler GitHub App',
      `<p>GitHub will create a private app owned by ${org ? `the organization <b>${esc(org)}</b>` : 'your GitHub account'} with these settings. You can change the name on the next page.</p>
<table><tr><th>Permissions</th><td>Checks: write · Pull requests: write · Contents: read · Metadata: read</td></tr>
<tr><th>Events</th><td>Pull request · Push · Check run · Check suite (installation events are always sent)</td></tr>
<tr><th>Webhook URL</th><td><code>${esc(deps.webhookUrl)}</code></td></tr>
<tr><th>Back to</th><td><code>${esc(publicUrl)}</code></td></tr></table>
<form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button type="submit">Create the GitHub App on GitHub</button></form>
<p class="muted">The private key, webhook secret and client secret come back once and are saved on this server with mode 0600.</p>`
    );
  });

  r.get('/github/register/callback', async (req, res) => {
    const who = await signedIn(req, res);
    if (!who) return;
    if (who.principal.globalRole !== 'admin') return sendPage(res, 403, 'Administrators only', '');
    sweep();
    const state = String(req.query.state || '');
    if (!pendingRegistrations.has(state)) return sendPage(res, 400, 'This registration link expired', '<p><a href="/github/register">Start again</a>.</p>');
    pendingRegistrations.delete(state);
    try {
      const credentials = await convertAppManifest(String(req.query.code || ''), deps.urls);
      const file = saveGitHubAppCredentials(credentials);
      deps.onRegistered({ ...credentials, source: 'file' });
      sendPage(
        res,
        200,
        'GitHub App created',
        `<p><b>${esc(credentials.name || credentials.slug)}</b> (app id ${esc(credentials.appId)}) is registered. Its credentials are in <code>${esc(file)}</code>.</p><p><a href="/github/install">Install it on your repositories →</a></p>`
      );
    } catch (err) {
      sendPage(res, 502, 'GitHub did not return the app', `<p>${esc((err as Error).message)}</p><p><a href="/github/register">Try again</a>.</p>`);
    }
  });

  // ---------------------------------------------------------------- 2. install and link to a workspace

  r.get('/github/install', async (req, res) => {
    const who = await signedIn(req, res);
    if (!who) return;
    const app = deps.getApp();
    if (!app) return sendPage(res, 409, 'The GitHub App is not registered yet', '<p>An administrator can <a href="/github/register">register it</a>.</p>');
    const owned = ownedWorkspaces(who.principal, who.user);
    const wanted = typeof req.query.workspace === 'string' ? req.query.workspace : owned.length === 1 ? owned[0].id : null;
    if (!wanted) {
      if (owned.length === 0) return sendPage(res, 403, 'You don\'t own a workspace', '<p>Ask a workspace owner to connect GitHub.</p>');
      return sendPage(res, 200, 'Which workspace?', `<ul>${owned.map((w) => `<li><a href="/github/install?workspace=${encodeURIComponent(w.id)}">${esc(w.name)}</a></li>`).join('')}</ul>`);
    }
    if (!owned.some((w) => w.id === wanted)) return sendPage(res, 404, 'Workspace not found', '');
    sweep();
    const state = newState();
    pendingLinks.set(state, { workspaceId: wanted, sub: who.principal.sub, expires: Date.now() + 30 * 60 * 1000 });
    const url = app.installUrl(state);
    if (!url) return sendPage(res, 500, 'The app has no slug', '<p>Set <code>LEXCOMPILER_GITHUB_APP_SLUG</code>.</p>');
    res.redirect(302, url);
  });

  r.get('/github/setup', async (req, res) => {
    const who = await signedIn(req, res);
    if (!who) return;
    const app = deps.getApp();
    if (!app) return sendPage(res, 409, 'The GitHub App is not registered', '');
    const installationId = Number(req.query.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return sendPage(res, 400, 'Missing installation id', '');
    sweep();
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    let pending = state ? pendingLinks.get(state) : undefined;
    if (state) pendingLinks.delete(state);
    if (!pending || pending.sub !== who.principal.sub) {
      // Installed from GitHub directly: use the person's only workspace, if there is exactly one.
      const owned = ownedWorkspaces(who.principal, who.user);
      if (owned.length !== 1) return sendPage(res, 400, 'Start from LexCompiler', '<p>Open <a href="/github/install">Connect GitHub</a> and choose the workspace.</p>');
      pending = { workspaceId: owned[0].id, sub: who.principal.sub, expires: Date.now() + 30 * 60 * 1000 };
    }
    pending.installationId = installationId;
    if (app.canVerifyUsers()) {
      // Confirm with GitHub that this person can access the installation (the id in the URL can be forged).
      const oauthState = newState();
      pendingLinks.set(oauthState, pending);
      return res.redirect(302, app.authorizeUrl(oauthState, callbackUrl));
    }
    if (who.principal.globalRole !== 'admin') {
      return sendPage(res, 403, 'Can\'t verify this installation', '<p>The app has no OAuth client secret, so only an administrator can link installations.</p>');
    }
    await finishLink(res, who, pending, { id: installationId, accountLogin: store.getInstallation(installationId)?.accountLogin ?? 'unknown', accountType: 'User' });
  });

  r.get('/github/oauth/callback', async (req, res) => {
    const who = await signedIn(req, res);
    if (!who) return;
    const app = deps.getApp();
    sweep();
    const state = String(req.query.state || '');
    const pending = pendingLinks.get(state);
    pendingLinks.delete(state);
    if (!app || !pending || pending.sub !== who.principal.sub || !pending.installationId) {
      return sendPage(res, 400, 'This link expired', '<p><a href="/github/install">Start again</a>.</p>');
    }
    if (req.query.error) return sendPage(res, 403, 'GitHub sign-in was cancelled', `<p>${esc(req.query.error_description || req.query.error)}</p>`);
    try {
      const token = await app.exchangeOAuthCode(String(req.query.code || ''), callbackUrl);
      const match = (await app.userInstallations(token)).find((i) => i.id === pending.installationId);
      if (!match) {
        return sendPage(res, 403, 'Not your installation', `<p>Your GitHub account can't access installation ${esc(pending.installationId)}, so it can't be linked.</p>`);
      }
      await finishLink(res, who, pending, match);
    } catch (err) {
      sendPage(res, 502, 'GitHub verification failed', `<p>${esc((err as Error).message)}</p>`);
    }
  });

  async function finishLink(
    res: Response,
    who: { principal: Principal; user: User },
    pending: PendingLink,
    inst: { id: number; accountLogin: string; accountType: string }
  ): Promise<void> {
    const app = deps.getApp()!;
    if (!ownedWorkspaces(who.principal, who.user).some((w) => w.id === pending.workspaceId)) return sendPage(res, 403, 'You no longer own that workspace', '');
    const current = store.getInstallation(inst.id)?.workspaceId;
    if (current && current !== pending.workspaceId && who.principal.globalRole !== 'admin' && store.roleOf(current, who.user.id) !== 'owner') {
      return sendPage(res, 409, 'Already linked', '<p>This installation belongs to another workspace. An owner of that workspace has to unlink it first.</p>');
    }
    try {
      store.upsertInstallation({ installationId: inst.id, accountLogin: inst.accountLogin, accountType: inst.accountType });
      store.linkInstallation(inst.id, pending.workspaceId);
      const repos = await app.installationRepositories(inst.id);
      for (const repo of repos) {
        store.upsertGithubRepo({ installationId: inst.id, githubRepoId: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch });
        enqueueScan(deps, { githubRepoId: repo.id, installationId: inst.id, kind: 'push', trigger: 'connect' }, `connect:${repo.id}`);
      }
      const ws = store.getWorkspace(pending.workspaceId);
      sendPage(
        res,
        200,
        'GitHub connected',
        `<p>Installation on <b>${esc(inst.accountLogin)}</b> is linked to <b>${esc(ws?.name)}</b>. LexCompiler now checks pull requests in:</p><ul>${repos.map((rp) => `<li><code>${esc(rp.fullName)}</code> (default branch <code>${esc(rp.defaultBranch)}</code>)</li>`).join('') || '<li class="muted">no repositories yet</li>'}</ul><p>A first scan of each default branch is queued; it becomes the baseline pull requests are compared against.</p>`
      );
    } catch (err) {
      sendPage(res, 502, 'Linking failed', `<p>${esc((err as Error).message)}</p>`);
    }
  }

  // ---------------------------------------------------------------- 3. a scan, linked from the GitHub check run

  // Older check runs link here; the scan page is part of the web app now.
  r.get('/scans/:scanId', (req, res) => res.redirect(302, `/app/checks/${encodeURIComponent(String(req.params.scanId))}`));

  return r;
}

/** GET /api/github/app: whether an app is registered (no secrets). Mounted behind the API guard. */
export function createGitHubApiRouter(getApp: () => GitHubApp | null) {
  const r = express.Router();
  r.get('/github/app', (_req, res) => {
    const app = getApp();
    const c = app?.credentials;
    res.json({
      configured: Boolean(app),
      appId: c?.appId ?? null,
      name: c?.name ?? null,
      slug: c?.slug ?? null,
      htmlUrl: c?.htmlUrl ?? null,
      verifiesInstallers: app?.canVerifyUsers() ?? false,
      registerUrl: '/github/register',
      installUrl: '/github/install',
    });
  });
  return r;
}
