import type { EvidenceEntry, EvidenceLog } from '../evidence/log.js';
import { enqueueScan } from '../github/webhooks.js';
import type { JobQueue } from '../jobs/queue.js';
import type { ExceptionRecord, GovernanceStore } from './governance.js';
import type { ClassifiedFinding } from './scanner.js';
import type { ProductStore, Rule, RuleVersion, ScanRecord } from './store.js';

/**
 * The steps that cross features: exceptions requested from GitHub, an assistant or the dashboard;
 * Legal's decisions; re-checking pull requests; and the evidence record for each.
 */
export interface FlowDeps {
  store: ProductStore;
  gov: GovernanceStore;
  evidence: EvidenceLog;
  /** Null in tests that don't run jobs. */
  queue: JobQueue | null;
  publicUrl: string;
}

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'no date');

export function personName(deps: Pick<FlowDeps, 'gov'>, userId: string | null | undefined): string {
  if (!userId) return 'someone';
  if (userId.startsWith('github:')) return `@${userId.slice(7)}`;
  if (userId === 'system:seed') return 'the demo seed';
  return deps.gov.people([userId]).get(userId)?.name ?? 'a member';
}

function comment(deps: FlowDeps, repoId: string | null, prNumber: number | null, body: string, dedupeKey: string): void {
  if (!deps.queue || !repoId || !prNumber) return;
  const repo = deps.store.getRepo(repoId);
  if (!repo || repo.source !== 'github' || !repo.installationId) return;
  deps.queue.enqueue('pr_comment', { installationId: repo.installationId, repoFullName: repo.fullName, prNumber, body }, { dedupeKey });
}

/** Re-runs the check of every open pull request whose newest scan has this finding. */
function recheckPullRequests(deps: FlowDeps, e: ExceptionRecord, reason: string): number[] {
  if (!deps.queue || !e.repoId || !e.fingerprint) return [];
  const repo = deps.store.getRepo(e.repoId);
  if (!repo || repo.source !== 'github' || !repo.installationId || !repo.githubRepoId) return [];
  const prs = deps.gov.pullRequestsWithFinding(repo.id, e.fingerprint);
  const latest = new Map(deps.gov.latestPullRequestScans(repo.id).map((s) => [s.prNumber, s]));
  for (const pr of prs) {
    const s = latest.get(pr)!;
    enqueueScan(
      { queue: deps.queue },
      { githubRepoId: repo.githubRepoId, installationId: repo.installationId, kind: 'pull_request', trigger: 'rerun', headSha: s.commitSha, baseSha: s.baseSha, prNumber: pr },
      `${reason}:${e.id}:pr${pr}:${Date.now()}`
    );
  }
  return prs;
}

function exceptionBody(e: ExceptionRecord): Record<string, unknown> {
  return {
    exception: e.id,
    rule: e.ruleKey,
    repo: e.repoFullName,
    pr: e.prNumber,
    location: e.filePath ? `${e.filePath}:${e.startLine}` : null,
    fingerprint: e.fingerprint,
    reason: e.reason,
    requested_by: e.requesterLabel,
    requested_from: e.requestedFrom,
  };
}

export interface FindingRef {
  ruleId: string;
  ruleKey: string;
  repoId: string | null;
  fingerprint: string;
  filePath: string;
  startLine: number;
  message: string;
  scanId?: string | null;
  prNumber?: number | null;
}

export function requestExceptions(
  deps: FlowDeps,
  input: { workspaceId: string; findings: FindingRef[]; reason: string; requestedBy: string; requesterLabel: string; via: 'github' | 'mcp' | 'dashboard' }
): Array<ExceptionRecord & { created: boolean }> {
  const out: Array<ExceptionRecord & { created: boolean }> = [];
  const fresh: ExceptionRecord[] = [];
  for (const f of input.findings) {
    const { record, created } = deps.gov.requestException({ ...f, workspaceId: input.workspaceId, reason: input.reason, requestedBy: input.requestedBy, requesterLabel: input.requesterLabel, requestedFrom: input.via });
    out.push({ ...record, created });
    if (created) {
      fresh.push(record);
      deps.evidence.append(input.workspaceId, 'exception.requested', exceptionBody(record));
    }
  }
  const byPr = new Map<string, ExceptionRecord[]>();
  for (const e of fresh) if (e.prNumber && e.repoId) byPr.set(`${e.repoId}#${e.prNumber}`, [...(byPr.get(`${e.repoId}#${e.prNumber}`) ?? []), e]);
  for (const list of byPr.values()) {
    const where = list.map((e) => `**${e.ruleKey}** at \`${e.filePath}:${e.startLine}\``).join(', ');
    const via = input.via === 'mcp' ? ' from a coding assistant' : input.via === 'dashboard' ? ' in LexCompiler' : '';
    comment(
      deps,
      list[0].repoId,
      list[0].prNumber,
      `**Exception requested** by ${input.requesterLabel}${via} for ${where}.\n\n> ${input.reason.replace(/\n+/g, ' ')}\n\nWaiting for Legal to decide in LexCompiler: ${deps.publicUrl}/app/exceptions`,
      `comment:requested:${list.map((e) => e.id).join(',')}`
    );
  }
  return out;
}

export function decideException(
  deps: FlowDeps,
  input: { workspaceId: string; exceptionId: string; decision: 'approved' | 'rejected'; userId: string; note: string; expiresAt?: string | null }
): ExceptionRecord {
  const e = deps.gov.decideException(input.workspaceId, input.exceptionId, input);
  const who = personName(deps, input.userId);
  deps.evidence.append(input.workspaceId, `exception.${input.decision}`, { ...exceptionBody(e), decided_by: who, note: e.decisionNote, expires_at: e.expiresAt });
  if (input.decision === 'approved') {
    const prs = recheckPullRequests(deps, e, 'approved');
    if (e.prNumber && !prs.includes(e.prNumber)) prs.push(e.prNumber);
    for (const pr of prs) {
      comment(
        deps,
        e.repoId,
        pr,
        `**Exception approved** by ${who} (Legal) for **${e.ruleKey}** at \`${e.filePath}:${e.startLine}\`, until ${day(e.expiresAt)}.${e.decisionNote ? `\n\n> ${e.decisionNote}` : ''}\n\nLexCompiler is re-running the check. The finding shows as waived until the exception expires.`,
        `comment:approved:${e.id}:${pr}`
      );
    }
  } else {
    comment(
      deps,
      e.repoId,
      e.prNumber,
      `**Exception rejected** by ${who} (Legal) for **${e.ruleKey}** at \`${e.filePath}:${e.startLine}\`.${e.decisionNote ? `\n\n> ${e.decisionNote}` : ''}\n\nThe finding still blocks this pull request.`,
      `comment:rejected:${e.id}`
    );
  }
  return e;
}

export function revokeException(deps: FlowDeps, input: { workspaceId: string; exceptionId: string; userId: string; note: string }): ExceptionRecord {
  const e = deps.gov.revokeException(input.workspaceId, input.exceptionId, input.userId, input.note);
  deps.evidence.append(input.workspaceId, 'exception.revoked', { ...exceptionBody(e), revoked_by: personName(deps, input.userId), note: input.note || null });
  recheckPullRequests(deps, e, 'revoked');
  return e;
}

/** Marks due exceptions expired, records each, and re-checks affected pull requests. */
export function expireExceptions(deps: FlowDeps): number {
  const due = deps.gov.expireDue();
  for (const e of due) {
    deps.evidence.append(e.workspaceId, 'exception.expired', { ...exceptionBody(e), expired_at: e.expiresAt });
    recheckPullRequests(deps, e, 'expired');
  }
  return due.length;
}

/** Records a rule decision; approvals and retirements re-check the default branch and open pull requests. */
export function ruleDecided(deps: FlowDeps, input: { workspaceId: string; rule: Rule; version?: RuleVersion; decision: 'approved' | 'rejected' | 'retired'; userId: string }): void {
  const v = input.version;
  deps.evidence.append(input.workspaceId, `rule.${input.decision}`, {
    rule: input.rule.key,
    title: input.rule.title,
    version: v?.version ?? null,
    clause_sha256: v?.clauseSha256 ?? null,
    category: v?.clause.category ?? null,
    effective_from: v?.effectiveFrom ?? null,
    source_text: v?.sourceText ?? null,
    answers: v?.answers ?? null,
    decided_by: personName(deps, input.userId),
    note: v?.decisionNote ?? null,
  });
  if (input.decision !== 'rejected') rulesChanged(deps, input.workspaceId);
}

export function rulesChanged(deps: FlowDeps, workspaceId: string): void {
  deps.queue?.enqueue('rules_changed', { workspaceId, stamp: Date.now() }, { dedupeKey: `rules_changed:${workspaceId}:${Date.now()}` });
}

/** The evidence record of a finished scan: what was checked, with which rule versions, and the result. */
export function recordScanEvidence(deps: Pick<FlowDeps, 'store' | 'evidence'>, scan: ScanRecord, findings: ClassifiedFinding[], extra: { checkRunUrl?: string | null } = {}): EvidenceEntry | null {
  const repo = deps.store.getRepo(scan.repoId);
  if (!repo?.workspaceId) return null;
  return deps.evidence.append(repo.workspaceId, 'scan.completed', {
    scan: scan.id,
    repo: repo.fullName,
    commit: scan.commitSha,
    base: scan.baseSha,
    pr: scan.prNumber,
    trigger: scan.trigger,
    conclusion: scan.conclusion,
    rules: scan.ruleVersions.map((r) => ({ rule: r.ruleKey, version: r.version, clause_sha256: r.clauseSha256 })),
    lexcompiler: scan.lexcompilerVersion,
    counts: scan.summary ? { new: scan.summary.newCount, existing: scan.summary.existingCount, waived: scan.summary.waivedCount } : null,
    findings: findings.map((f) => ({ rule: f.ruleKey, path: f.filePath, line: f.startLine, state: f.state, fingerprint: f.fingerprint, exception: f.exceptionId })),
    check_run: extra.checkRunUrl ?? null,
  });
}

/** "Request exception" on a GitHub check run: requests one for each new finding of that run. */
export function requestFromCheckRun(deps: FlowDeps, input: { checkRunId: number; login: string }): string {
  const scanId = deps.gov.scanIdForCheckRun(input.checkRunId);
  const scan = scanId ? deps.store.getScanById(scanId) : undefined;
  const repo = scan ? deps.store.getRepo(scan.repoId) : undefined;
  if (!scan || !repo?.workspaceId) return 'ignored: unknown check run';
  const findings = deps.store.listFindings(scan.id).filter((f) => f.state === 'new');
  if (findings.length === 0) return 'ignored: the check run has no new findings';
  const person = deps.gov.personByGithubLogin(input.login);
  const label = person?.name ? `${person.name} (@${input.login})` : `@${input.login}`;
  const records = requestExceptions(deps, {
    workspaceId: repo.workspaceId,
    findings: findings.map((f) => ({ ruleId: f.ruleId, ruleKey: f.ruleKey, repoId: repo.id, fingerprint: f.fingerprint, filePath: f.filePath, startLine: f.startLine, message: f.message, scanId: scan.id, prNumber: scan.prNumber })),
    reason: `Requested on GitHub from pull request #${scan.prNumber}.`,
    requestedBy: person?.id ?? `github:${input.login}`,
    requesterLabel: label,
    via: 'github',
  });
  const created = records.filter((r) => r.created).length;
  return created > 0 ? `exception requested for ${created} finding(s)` : `no new request: ${records.length} finding(s) already have a pending or approved exception`;
}
