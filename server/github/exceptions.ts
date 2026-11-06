import type { JobQueue } from '../jobs/queue.js';
import { GovernanceStore } from '../product/governance.js';
import type { ExceptionRecord, ProductStore } from '../product/store.js';
import type { GitHubApp } from './client.js';
import type { ScanJobPayload } from './scanJob.js';

/**
 * Exceptions from GitHub (product guide, Phase 4): the "Request exception" button on a failing
 * check, the comment that tells the PR it is waiting for Legal, and the re-run after Legal decides.
 */

export const REQUEST_EXCEPTION = 'request_exception';

/** The button GitHub shows on a failing pull request check (label ≤ 20, description ≤ 40 characters). */
export const REQUEST_EXCEPTION_ACTION = { label: 'Request exception', description: 'Ask Legal to waive the new findings', identifier: REQUEST_EXCEPTION } as const;

/** What a comment job carries. The older `repoFullName`/`prNumber` names (jobs queued before the merge) are still read. */
export interface CommentJobPayload {
  installationId: number;
  fullName: string;
  issueNumber: number;
  body: string;
}

/** Posts a comment on a pull request with the installation token. Registered as 'github_comment' and 'pr_comment'. */
export function createCommentJobHandler(deps: { getApp: () => GitHubApp | null }) {
  return async (raw: Record<string, unknown>): Promise<void> => {
    const p = raw as Partial<CommentJobPayload> & { repoFullName?: string; prNumber?: number };
    const fullName = p.fullName ?? p.repoFullName;
    const issueNumber = p.issueNumber ?? p.prNumber;
    if (typeof p.installationId !== 'number' || !fullName || !issueNumber) throw new Error('the comment job has no installation, repository or pull request');
    const app = deps.getApp();
    if (!app) throw new Error('The GitHub App is not configured on this server.');
    await app.request(p.installationId, 'POST', `/repos/${fullName}/issues/${issueNumber}/comments`, { body: String(p.body ?? '').slice(0, 60000) });
  };
}

/**
 * The open pull requests an exception touches, with the commits to check: every pull request whose
 * newest scan has the finding (at that scan's commits), plus the one the exception was requested on.
 */
export function exceptionPullRequests(deps: { store: ProductStore; gov?: GovernanceStore }, e: ExceptionRecord): Map<number, { headSha: string; baseSha: string | null }> {
  const targets = new Map<number, { headSha: string; baseSha: string | null }>();
  if (!e.repoId) return targets;
  const repo = deps.store.getRepo(e.repoId);
  if (!repo || repo.source !== 'github' || repo.githubRepoId === null || repo.installationId === null) return targets;
  if (e.fingerprint) {
    const gov = deps.gov ?? new GovernanceStore(deps.store.db, deps.store);
    const latest = new Map(gov.latestPullRequestScans(repo.id).map((s) => [s.prNumber, s]));
    for (const pr of gov.pullRequestsWithFinding(repo.id, e.fingerprint)) {
      const s = latest.get(pr);
      if (s) targets.set(pr, { headSha: s.commitSha, baseSha: s.baseSha });
    }
  }
  if (e.prNumber !== null && e.headSha && !targets.has(e.prNumber)) targets.set(e.prNumber, { headSha: e.headSha, baseSha: e.baseSha });
  return targets;
}

/**
 * Runs the check again after Legal decided, revoked or expired an exception: one job per decision
 * and pull request (see exceptionPullRequests). Returns the queued job ids.
 */
export function recheckForException(deps: { store: ProductStore; queue: JobQueue; gov?: GovernanceStore }, e: ExceptionRecord): string[] {
  const repo = e.repoId ? deps.store.getRepo(e.repoId) : undefined;
  if (!repo || repo.githubRepoId === null || repo.installationId === null) return [];
  const jobs: string[] = [];
  for (const [prNumber, t] of exceptionPullRequests(deps, e)) {
    const payload: ScanJobPayload = { githubRepoId: repo.githubRepoId, installationId: repo.installationId, kind: 'pull_request', trigger: 'rerun', headSha: t.headSha, baseSha: t.baseSha, prNumber };
    const id = deps.queue.enqueue('scan', payload as unknown as Record<string, unknown>, { dedupeKey: `exception:${e.id}:${e.status}:pr${prNumber}` });
    if (id) jobs.push(id);
  }
  return jobs;
}

/** Runs a pull request's check again after Legal decided an exception requested on it. */
export function rerunCheckForException(deps: { store: ProductStore; queue: JobQueue; gov?: GovernanceStore }, exception: ExceptionRecord): string | null {
  return recheckForException(deps, exception)[0] ?? null;
}

/** "1 finding waived until 30 Nov 2026" for the check summary; null when nothing is waived. */
export function waiverLine(scanFindings: Array<{ state: string; exceptionId: string | null }>, expiries: Map<string, string | null>): string | null {
  const waived = scanFindings.filter((f) => f.state === 'waived');
  if (waived.length === 0) return null;
  const dates = [...new Set(waived.map((f) => (f.exceptionId ? expiries.get(f.exceptionId) : null)).filter((d): d is string => Boolean(d)))].sort();
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const n = `${waived.length} finding${waived.length === 1 ? '' : 's'} waived`;
  return dates.length ? `${n} until ${fmt(dates[0])}${dates.length > 1 ? ` (the first of ${dates.length} expiry dates)` : ''}` : n;
}

