import type { ClassifiedFinding } from '../product/scanner.js';
import type { ExceptionRecord, ProductStore, Rule, RuleInEffect, RuleVersion, ScanRecord, ShareRecord } from '../product/store.js';
import { sha256, type EvidenceLog, type EvidenceType } from './log.js';

/**
 * The bodies of evidence records (product guide, Phase 5, item 1). Each names the rules and
 * repositories it is about (`ruleIds`, `repoIds`; an empty `repoIds` means the whole workspace),
 * so a share can pick its bodies. Bodies hold fingerprints, never code.
 */
export class EvidenceRecorder {
  constructor(
    readonly log: EvidenceLog,
    private readonly store: ProductStore
  ) {}

  private who(userId: string | null): { userId: string; email: string | null; name: string | null } | null {
    if (!userId) return null;
    if (userId.startsWith('github:')) return { userId, email: null, name: `@${userId.slice(7)} on GitHub` };
    const u = this.store.getUserById(userId);
    return { userId, email: u?.email ?? null, name: u?.name ?? null };
  }

  /** A completed scan: rule versions with their hashes, and per rule the fingerprints by state. */
  async scanCompleted(workspaceId: string, input: { scan: ScanRecord; rules: RuleInEffect[]; findings: ClassifiedFinding[]; undecidedRuleKeys: string[]; checkRunUrl?: string | null }) {
    const { scan, rules, findings } = input;
    const fps = (key: string, state: ClassifiedFinding['state']) => findings.filter((f) => f.ruleKey === key && f.state === state).map((f) => f.fingerprint).sort();
    const record = await this.log.append(workspaceId, 'scan.completed', {
      ruleIds: rules.map((r) => r.ruleId),
      repoIds: [scan.repoId],
      scanId: scan.id,
      repo: scan.repoFullName,
      commit: scan.commitSha,
      baseCommit: scan.baseSha,
      pullRequest: scan.prNumber,
      trigger: scan.trigger,
      conclusion: scan.conclusion,
      lexcompilerVersion: scan.lexcompilerVersion,
      filesScanned: scan.filesScanned,
      ruleVersions: rules.map((r) => ({ ruleId: r.ruleId, ruleKey: r.ruleKey, versionId: r.versionId, version: r.version, clauseSha256: r.clauseSha256 })),
      results: rules.map((r) => ({ ruleKey: r.ruleKey, new: fps(r.ruleKey, 'new'), existing: fps(r.ruleKey, 'existing'), waived: fps(r.ruleKey, 'waived') })),
      waived: findings.filter((f) => f.state === 'waived').map((f) => ({ fingerprint: f.fingerprint, exceptionId: f.exceptionId })),
      undecidedRules: input.undecidedRuleKeys,
      checkRunUrl: input.checkRunUrl ?? null,
    });
    this.store.setScanEvidence(scan.id, record.seq, record.headerSha256);
    return record;
  }

  async ruleApproved(workspaceId: string, version: RuleVersion) {
    const rule = this.store.getRule(workspaceId, version.ruleId);
    const doc = version.documentId ? this.store.listDocuments(workspaceId).find((d) => d.id === version.documentId) : undefined;
    return this.log.append(workspaceId, 'rule.approved', {
      ruleIds: [version.ruleId],
      repoIds: [],
      ruleKey: rule?.key ?? null,
      versionId: version.id,
      version: version.version,
      title: version.clause.title,
      citation: version.clause.citation,
      sourceTextSha256: sha256(version.sourceText),
      clauseSha256: version.clauseSha256,
      scope: version.scope,
      effectiveFrom: version.effectiveFrom,
      approvedBy: this.who(version.approvedBy),
      approvedAt: version.approvedAt,
      note: version.decisionNote,
      document: doc ? { id: doc.id, title: doc.title, fileSha256: doc.fileSha256 } : null,
    });
  }

  /** An approved version's effective date moved (before it took effect). */
  async ruleRescheduled(workspaceId: string, version: RuleVersion, userId: string) {
    const rule = this.store.getRule(workspaceId, version.ruleId);
    return this.log.append(workspaceId, 'rule.rescheduled', {
      ruleIds: [version.ruleId],
      repoIds: [],
      ruleKey: rule?.key ?? null,
      versionId: version.id,
      version: version.version,
      effectiveFrom: version.effectiveFrom,
      changedBy: this.who(userId),
    });
  }

  /** A draft version Legal turned down (nothing changes in checks; the decision is still on record). */
  async ruleRejected(workspaceId: string, rule: Rule, version: RuleVersion, userId: string) {
    return this.log.append(workspaceId, 'rule.rejected', {
      ruleIds: [rule.id],
      repoIds: [],
      ruleKey: rule.key,
      versionId: version.id,
      version: version.version,
      title: version.clause.title,
      citation: version.clause.citation,
      sourceTextSha256: sha256(version.sourceText),
      clauseSha256: version.clauseSha256,
      rejectedBy: this.who(userId),
      rejectedAt: version.approvedAt,
      note: version.decisionNote,
    });
  }

  async ruleRetired(workspaceId: string, rule: Rule, userId: string) {
    return this.log.append(workspaceId, 'rule.retired', { ruleIds: [rule.id], repoIds: [], ruleKey: rule.key, title: rule.title, retiredAt: rule.retiredAt, retiredBy: this.who(userId) });
  }

  /** The fields every exception body carries (fingerprints and locations, never code). */
  private exceptionBody(exception: ExceptionRecord) {
    return {
      ruleIds: [exception.ruleId],
      repoIds: exception.repoId ? [exception.repoId] : [],
      exceptionId: exception.id,
      ruleKey: exception.ruleKey,
      repo: exception.repoName,
      fingerprint: exception.fingerprint,
      pathGlob: exception.pathGlob,
      filePath: exception.filePath,
      startLine: exception.startLine,
      pullRequest: exception.prNumber,
      reason: exception.reason,
      requestedBy: this.who(exception.requestedBy),
      requesterLabel: exception.requesterLabel,
      requestedFrom: exception.requestedFrom,
      requestedAt: exception.requestedAt,
    };
  }

  /** A new exception request (from the check run's button, the dashboard or a coding assistant). */
  async exceptionRequested(exception: ExceptionRecord) {
    return this.log.append(exception.workspaceId, 'exception.requested', {
      ...this.exceptionBody(exception),
      requestedUntil: exception.requestedUntil,
      status: exception.status,
    });
  }

  /** An exception approved, rejected, expired or revoked, by its current status. */
  async exceptionChanged(exception: ExceptionRecord) {
    const type: EvidenceType | null =
      exception.status === 'approved'
        ? 'exception.approved'
        : exception.status === 'rejected'
          ? 'exception.rejected'
          : exception.status === 'expired'
            ? 'exception.expired'
            : exception.status === 'revoked'
              ? 'exception.revoked'
              : null;
    if (!type) return null;
    return this.log.append(exception.workspaceId, type, {
      ...this.exceptionBody(exception),
      decidedBy: this.who(exception.decidedBy),
      decidedAt: exception.decidedAt,
      decisionNote: exception.decisionNote,
      expiresAt: exception.expiresAt,
      status: exception.status,
      // A revoke records the revoker as the decider (ProductStore.revokeException).
      revokedBy: exception.status === 'revoked' ? this.who(exception.decidedBy) : undefined,
    });
  }

  /** An approved exception withdrawn before its end date, by `userId`, with an optional note. */
  async exceptionRevoked(exception: ExceptionRecord, userId: string, note?: string | null) {
    return this.log.append(exception.workspaceId, 'exception.revoked', {
      ...this.exceptionBody(exception),
      decidedBy: this.who(exception.decidedBy),
      decidedAt: exception.decidedAt,
      decisionNote: exception.decisionNote,
      expiresAt: exception.expiresAt,
      status: 'revoked',
      revokedBy: this.who(userId),
      revokedAt: exception.decidedAt,
      note: note?.trim() || null,
    });
  }

  /** A share link created or revoked; `userId` (who revoked it) is recorded as `revokedBy`. */
  async shareChanged(share: ShareRecord, change: 'created' | 'revoked', userId?: string | null) {
    return this.log.append(share.workspaceId, change === 'created' ? 'share.created' : 'share.revoked', {
      // No ruleIds: share records name counterparties and people, so no other share's view may include them.
      ruleIds: [],
      repoIds: [],
      shareId: share.id,
      label: share.label,
      counterparty: share.counterpartyId ? { id: share.counterpartyId, name: share.counterpartyName } : null,
      periodFrom: share.periodFrom,
      periodTo: share.periodTo,
      expiresAt: share.expiresAt,
      createdBy: this.who(share.createdBy),
      revokedAt: share.revokedAt,
      revokedBy: change === 'revoked' && userId ? this.who(userId) : undefined,
    });
  }
}

/** Whether a body belongs in a share of these rules and repositories. */
export function bodyInScope(bodyText: string, ruleIds: Set<string>, repoIds: Set<string>): boolean {
  const body = JSON.parse(bodyText) as { ruleIds?: string[]; repoIds?: string[] };
  const rules = body.ruleIds ?? [];
  const repos = body.repoIds ?? [];
  return rules.some((id) => ruleIds.has(id)) && (repos.length === 0 || repos.some((id) => repoIds.has(id)));
}
