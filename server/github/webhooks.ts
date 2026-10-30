import type { Request, Response } from 'express';
import type { JobQueue } from '../jobs/queue.js';
import type { ProductStore } from '../product/store.js';
import { verifyWebhookSignature, type GitHubApp } from './client.js';
import type { ScanJobPayload } from './scanJob.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const ZERO_SHA = /^0+$/;

export interface WebhookDeps {
  store: ProductStore;
  getApp: () => GitHubApp | null;
  queue: JobQueue;
  /** Deliveries arrive through a relay that re-stringifies JSON (smee.io); see verifyWebhookSignature. */
  relayReencoded?: boolean;
  /** "Request exception" was clicked on a check run. Returns what happened. */
  onRequestException?: (input: { checkRunId: number; login: string }) => string;
}

/**
 * POST /api/github/webhooks. Needs the raw body (express.raw) to check the signature, and only
 * records and queues work, because GitHub fails any delivery not answered within 10 seconds.
 */
export function createWebhookHandler(deps: WebhookDeps) {
  return (req: Request, res: Response): void => {
    const app = deps.getApp();
    if (!app) {
      res.status(503).json({ error: 'The GitHub App is not configured on this server.' });
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyWebhookSignature(app.credentials.webhookSecret, raw, req.header('x-hub-signature-256'), { relayReencoded: deps.relayReencoded })) {
      res.status(401).json({ error: 'Invalid webhook signature.' });
      return;
    }
    const event = req.header('x-github-event') || '';
    const deliveryId = req.header('x-github-delivery') || '';
    let payload: Obj;
    try {
      const body = raw.toString('utf8');
      const json = (req.header('content-type') || '').includes('application/x-www-form-urlencoded') ? new URLSearchParams(body).get('payload') || '' : body;
      payload = obj(JSON.parse(json));
    } catch {
      res.status(400).json({ error: 'The payload is not JSON.' });
      return;
    }
    if (!event || !deliveryId) {
      res.status(400).json({ error: 'Missing X-GitHub-Event or X-GitHub-Delivery.' });
      return;
    }
    if (!deps.store.recordWebhookDelivery(deliveryId, event, text(payload.action))) {
      res.status(200).json({ duplicate: true });
      return;
    }
    try {
      res.status(202).json({ accepted: true, result: routeEvent(event, payload, deps, app, deliveryId) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

function routeEvent(event: string, payload: Obj, deps: WebhookDeps, app: GitHubApp, deliveryId: string): string {
  const { store } = deps;
  const action = text(payload.action);
  const installation = obj(payload.installation);
  const installationId = num(installation.id);
  const repository = obj(payload.repository);

  if (event === 'ping') return 'pong';
  if (installationId === null) return 'ignored: no installation';

  if (event === 'installation') {
    if (action === 'deleted' || action === 'suspend') {
      store.removeInstallation(installationId);
      return `installation ${action}`;
    }
    const account = obj(installation.account);
    store.upsertInstallation({ installationId, accountLogin: text(account.login) ?? 'unknown', accountType: text(account.type) ?? 'User' });
    for (const r of Array.isArray(payload.repositories) ? payload.repositories : []) {
      const repo = obj(r);
      const id = num(repo.id);
      const fullName = text(repo.full_name);
      if (id !== null && fullName) store.upsertGithubRepo({ installationId, githubRepoId: id, fullName });
    }
    return `installation ${action ?? 'updated'}`;
  }

  if (event === 'installation_repositories') {
    const linked = Boolean(store.getInstallation(installationId)?.workspaceId);
    for (const r of Array.isArray(payload.repositories_added) ? payload.repositories_added : []) {
      const repo = obj(r);
      const id = num(repo.id);
      const fullName = text(repo.full_name);
      if (id === null || !fullName) continue;
      store.upsertGithubRepo({ installationId, githubRepoId: id, fullName });
      if (linked) enqueueScan(deps, { githubRepoId: id, installationId, kind: 'push', trigger: 'connect' }, `connect:${id}`);
    }
    for (const r of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []) {
      const id = num(obj(r).id);
      if (id !== null) store.removeGithubRepo(id);
    }
    return 'repositories updated';
  }

  const githubRepoId = num(repository.id);
  const fullName = text(repository.full_name);
  if (githubRepoId === null || !fullName) return `ignored: ${event} without a repository`;
  const defaultBranch = text(repository.default_branch) ?? undefined;

  if (event === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action ?? '')) return `ignored: pull_request.${action}`;
    const pr = obj(payload.pull_request);
    const headSha = text(obj(pr.head).sha);
    const baseSha = text(obj(pr.base).sha);
    const prNumber = num(pr.number);
    if (!headSha || prNumber === null) return 'ignored: pull request without a head commit';
    store.upsertGithubRepo({ installationId, githubRepoId, fullName, defaultBranch });
    enqueueScan(deps, { githubRepoId, installationId, kind: 'pull_request', trigger: 'pull_request', headSha, baseSha, prNumber }, `scan:${githubRepoId}:${headSha}:pr${prNumber}`);
    return `scan queued for #${prNumber} @ ${headSha.slice(0, 7)}`;
  }

  if (event === 'push') {
    const after = text(payload.after);
    if (payload.deleted === true || !after || ZERO_SHA.test(after)) return 'ignored: branch deleted';
    if (!defaultBranch || payload.ref !== `refs/heads/${defaultBranch}`) return 'ignored: not the default branch';
    store.upsertGithubRepo({ installationId, githubRepoId, fullName, defaultBranch });
    enqueueScan(deps, { githubRepoId, installationId, kind: 'push', trigger: 'push', headSha: after }, `scan:${githubRepoId}:${after}:push`);
    return `scan queued for ${defaultBranch} @ ${after.slice(0, 7)}`;
  }

  if (event === 'check_run' || event === 'check_suite') {
    const subject = obj(event === 'check_run' ? payload.check_run : payload.check_suite);
    const ownerAppId = num(obj(subject.app).id);
    if (ownerAppId !== null && String(ownerAppId) !== app.credentials.appId) return `ignored: another app's ${event}`;
    if (action === 'requested_action') {
      const identifier = text(obj(payload.requested_action).identifier);
      const checkRunId = num(subject.id);
      if (event !== 'check_run' || identifier !== 'request_exception' || checkRunId === null) return `ignored: action ${identifier ?? 'unknown'}`;
      if (!deps.onRequestException) return 'ignored: exceptions are not enabled on this server';
      return deps.onRequestException({ checkRunId, login: text(obj(payload.sender).login) ?? 'unknown' });
    }
    if (action !== 'rerequested') return `ignored: ${event}.${action}`;
    const headSha = text(subject.head_sha);
    if (!headSha) return `ignored: ${event} without a head commit`;
    const pr = obj(Array.isArray(subject.pull_requests) ? subject.pull_requests[0] : undefined);
    const prNumber = num(pr.number);
    store.upsertGithubRepo({ installationId, githubRepoId, fullName, defaultBranch });
    enqueueScan(
      deps,
      {
        githubRepoId,
        installationId,
        kind: prNumber !== null ? 'pull_request' : 'push',
        trigger: 'rerun',
        headSha,
        baseSha: text(obj(pr.base).sha),
        prNumber,
      },
      // Each click on "Re-run" is its own delivery, so it gets its own scan.
      `rerun:${deliveryId}`
    );
    return `re-run queued @ ${headSha.slice(0, 7)}`;
  }

  return `ignored: ${event}`;
}

export function enqueueScan(deps: Pick<WebhookDeps, 'queue'>, payload: ScanJobPayload, dedupeKey: string): string | null {
  return deps.queue.enqueue('scan', payload as unknown as Record<string, unknown>, { dedupeKey });
}
