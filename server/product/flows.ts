import type { EvidenceRecorder } from '../evidence/records.js';
import { emitWorkspaceEvent, exceptionEventData } from '../events/outbound.js';
import { exceptionPullRequests, recheckForException } from '../github/exceptions.js';
import type { JobQueue } from '../jobs/queue.js';
import { GovernanceStore } from './governance.js';
import type { ClassifiedFinding } from './scanner.js';
import { StoreError, type ExceptionRecord, type ProductStore, type Rule, type RuleInEffect, type RuleScope, type RuleVersion, type ScanRecord } from './store.js';

/**
 * The steps that cross features: exceptions requested from GitHub, an assistant or the dashboard;
 * Legal's decisions; re-checking pull requests; and the evidence record for each. This is the one
 * exception lifecycle (request, decide, revoke, expire); the routes, the MCP tools and the GitHub
 * webhook all go through it.
 */
export interface FlowDeps {
  store: ProductStore;
  /** Names of people and the pull requests a finding is on. Built from the store when missing. */
  gov?: GovernanceStore;
  /** Signs the evidence record of each step. Without it nothing is recorded (tests that don't need it). */
  evidence?: EvidenceRecorder;
  /** Null in tests that don't run jobs. */
  queue: JobQueue | null;
  publicUrl: string;
}

const govOf = (deps: Pick<FlowDeps, 'store' | 'gov'>): GovernanceStore => deps.gov ?? new GovernanceStore(deps.store.db, deps.store);
const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'no date');

export function personName(deps: Pick<FlowDeps, 'store' | 'gov'>, userId: string | null | undefined): string {
  if (!userId) return 'someone';
  if (userId.startsWith('github:')) return `@${userId.slice(7)}`;
  if (userId === 'system:seed') return 'the demo seed';
  return govOf(deps).people([userId]).get(userId)?.name ?? 'a member';
}

/** A comment on a pull request, as a job; nothing for repositories that are not on GitHub. */
function comment(deps: FlowDeps, repoId: string | null, prNumber: number | null, body: string, dedupeKey: string): void {
  if (!deps.queue || !repoId || !prNumber) return;
  const repo = deps.store.getRepo(repoId);
  if (!repo || repo.source !== 'github' || !repo.installationId) return;
  deps.queue.enqueue('github_comment', { installationId: repo.installationId, fullName: repo.fullName, issueNumber: prNumber, body }, { dedupeKey });
}

/** Runs the checks again and returns the first job's id (null when nothing was queued). */
function recheck(deps: FlowDeps, e: ExceptionRecord): string | null {
  if (!deps.queue) return null;
  return recheckForException({ store: deps.store, queue: deps.queue, gov: deps.gov }, e)[0] ?? null;
}

export interface FindingRef {
  ruleId: string;
  ruleKey: string;
  repoId: string | null;
  /** One finding. Without it, `pathGlob` covers the paths of a rule (exactly one of the two). */
  fingerprint?: string | null;
  pathGlob?: string | null;
  filePath?: string;
  startLine?: number;
  message?: string;
  scanId?: string | null;
  prNumber?: number | null;
}

export type ExceptionVia = 'github' | 'assistant' | 'mcp' | 'dashboard';

export async function requestExceptions(
  deps: FlowDeps,
  input: { workspaceId: string; findings: FindingRef[]; reason: string; requestedBy: string; requesterLabel: string; via: ExceptionVia; requestedUntil?: string | null }
): Promise<Array<ExceptionRecord & { created: boolean }>> {
  const via = input.via === 'mcp' ? 'assistant' : input.via;
  const out: Array<ExceptionRecord & { created: boolean }> = [];
  const fresh: ExceptionRecord[] = [];
  for (const f of input.findings) {
    const scan = f.scanId ? deps.store.getScanById(f.scanId) : undefined;
    const { exception, created } = deps.store.requestException({
      workspaceId: input.workspaceId,
      ruleId: f.ruleId,
      ruleKey: f.ruleKey,
      repoId: f.repoId,
      fingerprint: f.fingerprint,
      pathGlob: f.pathGlob,
      reason: input.reason,
      requestedBy: input.requestedBy,
      requesterLabel: input.requesterLabel,
      requestedFrom: via,
      requestedUntil: input.requestedUntil,
      scan: scan ? { id: scan.id, prNumber: scan.prNumber, headSha: scan.commitSha, baseSha: scan.baseSha } : null,
      prNumber: f.prNumber ?? null,
      finding: f.filePath !== undefined ? { filePath: f.filePath, startLine: f.startLine ?? 0, message: f.message ?? '' } : null,
    });
    out.push({ ...exception, created });
    if (created) {
      fresh.push(exception);
      await deps.evidence?.exceptionRequested(exception);
      emitWorkspaceEvent(deps, input.workspaceId, 'exception.requested', exceptionEventData(exception, deps.publicUrl));
    }
  }
  const byPr = new Map<string, ExceptionRecord[]>();
  for (const e of fresh) if (e.prNumber && e.repoId) byPr.set(`${e.repoId}#${e.prNumber}`, [...(byPr.get(`${e.repoId}#${e.prNumber}`) ?? []), e]);
  for (const list of byPr.values()) {
    const where = list.map((e) => (e.filePath ? `- **${e.ruleKey}** \`${e.filePath}:${e.startLine}\`` : `- **${e.ruleKey}**${e.pathGlob ? ` \`${e.pathGlob}\`` : ''}`)).join('\n');
    const from = via === 'assistant' ? ' from a coding assistant' : via === 'dashboard' ? ' in LexCompiler' : '';
    comment(
      deps,
      list[0].repoId,
      list[0].prNumber,
      `Exception requested by ${input.requesterLabel}${from} — waiting for Legal.\n\n${where}\n\n> ${input.reason.replace(/\n+/g, ' ')}\n\nThe check runs again when Legal decides: ${deps.publicUrl}/app/exceptions`,
      `comment:requested:${list.map((e) => e.id).join(',')}`
    );
  }
  return out;
}

export async function decideException(
  deps: FlowDeps,
  input: { workspaceId: string; exceptionId: string; decision: 'approved' | 'rejected'; userId: string; note: string; expiresAt?: string | null }
): Promise<ExceptionRecord & { rerunJobId: string | null }> {
  const approve = input.decision === 'approved';
  if (approve && !input.expiresAt) throw new StoreError('an approved exception needs an expiry date');
  const e = deps.store.decideException(
    input.workspaceId,
    input.exceptionId,
    input.userId,
    approve ? { approve: true, note: input.note, expiresAt: input.expiresAt as string } : { approve: false, note: input.note }
  );
  await deps.evidence?.exceptionChanged(e);
  emitWorkspaceEvent(deps, input.workspaceId, 'exception.decided', exceptionEventData(e, deps.publicUrl));
  const who = personName(deps, input.userId);
  let rerunJobId: string | null = null;
  if (approve) {
    for (const pr of exceptionPullRequests({ store: deps.store, gov: deps.gov }, e).keys()) {
      comment(
        deps,
        e.repoId,
        pr,
        `**Exception approved** by ${who} (Legal) for **${e.ruleKey}** at \`${e.filePath}:${e.startLine}\`, until ${day(e.expiresAt)}.${e.decisionNote ? `\n\n> ${e.decisionNote}` : ''}\n\nLexCompiler is re-running the check. The finding shows as waived until the exception expires.`,
        `comment:approved:${e.id}:${pr}`
      );
    }
    rerunJobId = recheck(deps, e);
  } else {
    comment(
      deps,
      e.repoId,
      e.prNumber,
      `**Exception rejected** by ${who} (Legal) for **${e.ruleKey}** at \`${e.filePath}:${e.startLine}\`.${e.decisionNote ? `\n\n> ${e.decisionNote}` : ''}\n\nThe finding still blocks this pull request.`,
      `comment:rejected:${e.id}`
    );
  }
  return { ...e, rerunJobId };
}

export async function revokeException(deps: FlowDeps, input: { workspaceId: string; exceptionId: string; userId: string; note: string }): Promise<ExceptionRecord & { rerunJobId: string | null }> {
  const e = deps.store.revokeException(input.workspaceId, input.exceptionId, input.userId, input.note);
  await deps.evidence?.exceptionRevoked(e, input.userId, input.note);
  return { ...e, rerunJobId: recheck(deps, e) };
}

/** Marks due exceptions expired, records each, and re-checks affected pull requests. The one sweep: at startup and every 10 minutes. */
export async function expireExceptions(deps: FlowDeps): Promise<number> {
  const due = deps.store.expireExceptionRecords();
  for (const e of due) {
    await deps.evidence?.exceptionChanged(e);
    recheck(deps, e);
  }
  return due.length;
}

/**
 * A rule decision made by Legal. Approvals and retirements are recorded by the route that makes
 * them (with the version it just wrote); this records a rejection and queues the re-checks that
 * approvals and retirements need (the default branch and every open pull request).
 */
export async function ruleDecided(deps: FlowDeps, input: { workspaceId: string; rule: Rule; version?: RuleVersion; decision: 'approved' | 'rejected' | 'retired'; userId: string }): Promise<void> {
  if (input.decision === 'rejected') {
    if (input.version) await deps.evidence?.ruleRejected(input.workspaceId, input.rule, input.version, input.userId);
    return;
  }
  rulesChanged(deps, input.workspaceId, input.version?.scope ?? input.rule.versions.at(-1)?.scope);
}

/** Queue a re-check of the open pull requests of the repositories the changed rule covers (all of them without a scope). */
export function rulesChanged(deps: Pick<FlowDeps, 'queue'>, workspaceId: string, scope?: RuleScope): void {
  deps.queue?.enqueue('rules_changed', { workspaceId, scope, stamp: Date.now() }, { dedupeKey: `rules_changed:${workspaceId}:${Date.now()}` });
}

/** The evidence record of a finished scan: what was checked, with which rule versions, and the result. */
export async function recordScanEvidence(
  deps: Pick<FlowDeps, 'store' | 'evidence'>,
  scan: ScanRecord,
  findings: ClassifiedFinding[],
  extra: { checkRunUrl?: string | null } = {}
): Promise<{ seq: number; headerSha256: string } | null> {
  const repo = deps.store.getRepo(scan.repoId);
  if (!repo?.workspaceId || !deps.evidence) return null;
  const rules: RuleInEffect[] = [];
  for (const rv of scan.ruleVersions) {
    const v = deps.store.getRuleVersion(repo.workspaceId, rv.versionId);
    if (v) rules.push({ ruleId: v.ruleId, ruleKey: rv.ruleKey, versionId: rv.versionId, version: rv.version, clause: v.clause, clauseSha256: rv.clauseSha256, scope: v.scope });
  }
  const undecided = scan.summary?.undecidedRuleKeys ?? [];
  return deps.evidence.scanCompleted(repo.workspaceId, { scan, rules, findings, undecidedRuleKeys: undecided, checkRunUrl: extra.checkRunUrl ?? null });
}

/**
 * "Request exception" on a GitHub check run: requests one for each new finding of that run.
 * The webhook calls this with or without the server's own wiring (people, evidence).
 */
export async function requestFromCheckRun(deps: FlowDeps, input: { checkRunId: number; login: string; installationId?: number; deliveryId?: string }): Promise<string> {
  const scan = deps.store.getScanByCheckRun(input.checkRunId);
  if (!scan) return 'ignored: no LexCompiler scan for this check run';
  const repo = deps.store.getRepo(scan.repoId);
  if (!repo?.workspaceId) return 'ignored: the repository is not linked to a workspace';
  if (scan.prNumber === null) return 'ignored: exceptions are requested on pull requests';
  const findings = deps.store.listFindings(scan.id).filter((f) => f.state === 'new');
  if (findings.length === 0) return 'ignored: the check has no new findings';
  const person = govOf(deps).personByGithubLogin(input.login);
  const label = person?.name ? `${person.name} (@${input.login})` : `@${input.login}`;
  const records = await requestExceptions(deps, {
    workspaceId: repo.workspaceId,
    findings: findings.map((f) => ({ ruleId: f.ruleId, ruleKey: f.ruleKey, repoId: repo.id, fingerprint: f.fingerprint, filePath: f.filePath, startLine: f.startLine, message: f.message, scanId: scan.id, prNumber: scan.prNumber })),
    reason: `Requested from GitHub by @${input.login} on pull request #${scan.prNumber}`,
    requestedBy: person?.id ?? `github:${input.login}`,
    requesterLabel: label,
    via: 'github',
  });
  const created = records.filter((r) => r.created).length;
  return created > 0 ? `exception requested for ${created} finding${created === 1 ? '' : 's'}` : 'exception already requested';
}
