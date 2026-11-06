import { nowIso, type Db } from '../db/index.js';
import {
  ProductStore,
  StoreError,
  type ApiTokenRecord as ProductApiTokenRecord,
  type BranchScanRecord,
  type ExceptionRecord as ProductExceptionRecord,
  type ExceptionSource,
  type ExceptionStatus as ProductExceptionStatus,
  type McpCallOutcome,
  type ShareRecord as ProductShareRecord,
  type WorkspaceRole,
} from './store.js';

/**
 * The governance features as Shahriar's dashboard, flows and assistants call them: sign-in
 * accounts, assistant tokens and their MCP calls, exceptions, and share links.
 *
 * ProductStore is the one engine. Tokens, the MCP log, exceptions, shares and the branch-scan
 * lookup are adapters over it (so both dashboards read and write the same rows under the same
 * rules). Only what ProductStore has no equivalent for keeps its own SQL here: people and
 * passwords, profiles, workspace plan and archive, usage counters, and pull-request lookups.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const int = (v: unknown): number | null => (v == null ? null : Number(v));

export interface PersonSummary {
  id: string;
  name: string | null;
  email: string | null;
  title: string | null;
  githubLogin: string | null;
}

export interface ApiTokenRecord {
  id: string;
  workspaceId: string;
  userId: string;
  userName: string | null;
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastClient: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface McpCallRecord {
  id: string;
  userId: string | null;
  userName: string | null;
  client: string | null;
  method: string;
  tool: string | null;
  repo: string | null;
  outcome: string;
  summary: string | null;
  durationMs: number;
  createdAt: string;
}

export type ExceptionStatus = ProductExceptionStatus;
/** ProductStore's record, which carries every field this API had (ruleTitle, repoFullName, requesterLabel, decidedByName). */
export type ExceptionRecord = ProductExceptionRecord;
/** ProductStore's record, which carries every field this API had (createdByName, lastViewedAt, status). */
export type ShareRecord = ProductShareRecord;

export interface BranchScan extends BranchScanRecord {
  facts: { sqlTables: unknown[]; astFindings: unknown[] } | null;
}

/** Old callers say 'mcp' for a request made by a coding assistant; it is stored as 'assistant'. */
const sourceOf = (from: 'github' | 'mcp' | 'dashboard' | 'assistant'): ExceptionSource => (from === 'mcp' ? 'assistant' : from);

export class GovernanceStore {
  readonly store: ProductStore;

  constructor(
    readonly db: Db,
    store?: ProductStore
  ) {
    this.store = store ?? new ProductStore(db);
  }

  // ---------------------------------------------------------------- people and sign-in

  findUserByEmail(email: string): { id: string; sub: string; email: string | null; name: string | null; passwordHash: string | null } | undefined {
    const r = this.db
      .prepare('SELECT id, oidc_sub, email, name, password_hash FROM users WHERE lower(email) = ? ORDER BY password_hash IS NULL, created_at LIMIT 1')
      .get(email.trim().toLowerCase()) as Row | undefined;
    return r ? { id: String(r.id), sub: String(r.oidc_sub), email: str(r.email), name: str(r.name), passwordHash: str(r.password_hash) } : undefined;
  }

  setPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(passwordHash, userId);
  }

  setProfile(userId: string, profile: { title?: string | null; githubLogin?: string | null }): void {
    if (profile.title !== undefined) this.db.prepare('UPDATE users SET title = ? WHERE id = ?').run(profile.title, userId);
    if (profile.githubLogin !== undefined) {
      const login = profile.githubLogin?.trim() || null;
      // A GitHub login maps to one person.
      if (login) this.db.prepare('UPDATE users SET github_login = NULL WHERE lower(github_login) = ? AND id <> ?').run(login.toLowerCase(), userId);
      this.db.prepare('UPDATE users SET github_login = ? WHERE id = ?').run(login, userId);
    }
  }

  people(ids: Iterable<string>): Map<string, PersonSummary> {
    const unique = [...new Set([...ids].filter(Boolean))];
    const out = new Map<string, PersonSummary>();
    if (unique.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT id, name, email, title, github_login FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`)
      .all(...unique) as Row[];
    for (const r of rows) out.set(String(r.id), { id: String(r.id), name: str(r.name), email: str(r.email), title: str(r.title), githubLogin: str(r.github_login) });
    return out;
  }

  personByGithubLogin(login: string): PersonSummary | undefined {
    const r = this.db.prepare('SELECT id, name, email, title, github_login FROM users WHERE lower(github_login) = ?').get(login.toLowerCase()) as Row | undefined;
    return r ? { id: String(r.id), name: str(r.name), email: str(r.email), title: str(r.title), githubLogin: str(r.github_login) } : undefined;
  }

  workspaceMeta(workspaceId: string): { plan: string; archivedAt: string | null } {
    const r = this.db.prepare('SELECT plan, archived_at FROM workspaces WHERE id = ?').get(workspaceId) as Row | undefined;
    return { plan: String(r?.plan ?? 'pilot'), archivedAt: str(r?.archived_at) };
  }

  archiveWorkspace(workspaceId: string, newName: string): void {
    this.db.prepare('UPDATE workspaces SET archived_at = ?, name = ? WHERE id = ?').run(nowIso(), newName, workspaceId);
  }

  // ---------------------------------------------------------------- assistant tokens (adapters over ProductStore)

  /** Tokens made before hints were kept have none; they show an empty hint. */
  private tokenFrom(t: ProductApiTokenRecord): ApiTokenRecord {
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      userId: t.userId,
      userName: t.userName,
      name: t.name,
      hint: t.hint ?? '',
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      lastClient: t.lastClient,
      revokedAt: t.revokedAt,
      status: t.status,
    };
  }

  /** Creates a token. The secret is returned once and only its SHA-256 (and last four characters) is kept. */
  createToken(input: { workspaceId: string; userId: string; name: string; days: number }): { token: string; record: ApiTokenRecord } {
    const { token, record } = this.store.createApiToken(input.workspaceId, input.userId, input.name, input.days);
    return { token, record: this.tokenFrom(record) };
  }

  getToken(workspaceId: string, tokenId: string): ApiTokenRecord | undefined {
    const t = this.store.getApiToken(workspaceId, tokenId);
    return t ? this.tokenFrom(t) : undefined;
  }

  /** A person's tokens, or every token in the workspace when `userId` is null. */
  listTokens(workspaceId: string, userId: string | null): ApiTokenRecord[] {
    return (userId === null ? this.store.listAllApiTokens(workspaceId) : this.store.listApiTokens(workspaceId, userId)).map((t) => this.tokenFrom(t));
  }

  revokeToken(workspaceId: string, tokenId: string, actor: { userId: string; canRevokeOthers: boolean }): ApiTokenRecord {
    const t = this.store.getApiToken(workspaceId, tokenId);
    if (!t) throw new StoreError('token not found', 404);
    if (t.userId !== actor.userId && !actor.canRevokeOthers) throw new StoreError('only the token owner or a workspace owner can revoke it', 403);
    return this.tokenFrom(this.store.revokeApiToken(workspaceId, actor.userId, tokenId, { canRevokeOthers: actor.canRevokeOthers }));
  }

  /** Resolves a bearer token to its person, workspace and current role; null when unknown, expired, revoked, archived or no longer a member. */
  authenticateToken(secret: string): { token: ApiTokenRecord; user: { id: string; sub: string; email: string | null; name: string | null }; role: WorkspaceRole } | null {
    const principal = this.store.tokenPrincipal(secret);
    if (!principal) return null;
    const token = this.store.getApiToken(principal.workspaceId, principal.tokenId);
    const user = this.store.getUserById(principal.userId);
    if (!token || !user) return null;
    return { token: this.tokenFrom(token), user: { id: user.id, sub: principal.userSub, email: user.email, name: user.name }, role: principal.role };
  }

  setTokenClient(tokenId: string, client: string): void {
    this.store.setApiTokenClient(tokenId, client);
  }

  // ---------------------------------------------------------------- MCP calls (adapters over ProductStore)

  logMcpCall(input: { workspaceId: string; tokenId: string | null; userId: string | null; client: string | null; method: string; tool?: string | null; repo?: string | null; outcome: string; summary?: string | null; durationMs: number }): void {
    this.store.recordMcpCall({
      workspaceId: input.workspaceId,
      tokenId: input.tokenId,
      userId: input.userId,
      client: input.client,
      method: input.method,
      tool: input.tool ?? null,
      repo: input.repo ?? null,
      outcome: input.outcome as McpCallOutcome,
      summary: input.summary ?? null,
      durationMs: input.durationMs,
      detail: null,
    });
  }

  /** Tool calls only (not handshakes or listings), with the person who made them. */
  listMcpCalls(workspaceId: string, limit = 50): McpCallRecord[] {
    return this.store.listMcpCalls(workspaceId, limit, { toolCallsOnly: true }).map((c) => ({
      id: c.id,
      userId: c.userId,
      userName: c.userName,
      client: c.client,
      method: c.method,
      tool: c.tool,
      repo: c.repo,
      outcome: c.outcome,
      summary: c.summary,
      durationMs: c.durationMs,
      createdAt: c.createdAt,
    }));
  }

  countSince(table: 'mcp_calls' | 'ai_calls', workspaceId: string, since: string): number {
    const extra = table === 'mcp_calls' ? ' AND tool IS NOT NULL' : '';
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND created_at >= ?${extra}`).get(workspaceId, since) as Row).n);
  }

  tokensSince(workspaceId: string, since: string): number {
    return Number(
      (this.db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_calls WHERE workspace_id = ? AND created_at >= ?').get(workspaceId, since) as Row).n
    );
  }

  // ---------------------------------------------------------------- exceptions (adapters over ProductStore)

  getException(workspaceId: string, id: string): ExceptionRecord | undefined {
    return this.store.getException(workspaceId, id);
  }

  listExceptions(workspaceId: string, statuses?: ExceptionStatus[]): ExceptionRecord[] {
    return this.store.listExceptions(workspaceId, statuses?.length ? { status: statuses } : {});
  }

  /**
   * Records a request. A finding with a pending or active exception gets that one back instead of a second.
   * `expiresAt` is the end date the requester asks for; it is kept as `requestedUntil`, and Legal sets
   * the real expiry when approving.
   */
  requestException(input: {
    workspaceId: string;
    ruleId: string;
    ruleKey: string;
    repoId: string | null;
    fingerprint: string;
    filePath: string;
    startLine: number;
    message: string;
    reason: string;
    requestedBy: string;
    requesterLabel: string;
    requestedFrom: 'github' | 'mcp' | 'dashboard' | 'assistant';
    prNumber?: number | null;
    scanId?: string | null;
    expiresAt?: string | null;
  }): { record: ExceptionRecord; created: boolean } {
    const scan = input.scanId ? this.store.getScanById(input.scanId) : undefined;
    const { exception, created } = this.store.requestException({
      workspaceId: input.workspaceId,
      ruleId: input.ruleId,
      ruleKey: input.ruleKey,
      repoId: input.repoId,
      fingerprint: input.fingerprint,
      reason: input.reason,
      requestedBy: input.requestedBy,
      requesterLabel: input.requesterLabel,
      requestedFrom: sourceOf(input.requestedFrom),
      requestedUntil: input.expiresAt ?? null,
      scan: scan ? { id: scan.id, prNumber: input.prNumber ?? scan.prNumber, headSha: scan.commitSha, baseSha: scan.baseSha } : null,
      prNumber: input.prNumber ?? null,
      finding: { filePath: input.filePath, startLine: input.startLine, message: input.message },
    });
    return { record: exception, created };
  }

  /** Legal's decision. Approval needs a note and an expiry date in the future (at most a year). */
  decideException(workspaceId: string, id: string, input: { decision: 'approved' | 'rejected'; userId: string; note: string; expiresAt?: string | null }): ExceptionRecord {
    if (input.decision === 'approved') {
      if (!input.expiresAt || !Number.isFinite(Date.parse(input.expiresAt))) {
        if (!this.store.getException(workspaceId, id)) throw new StoreError('exception not found', 404);
        throw new StoreError('an approved exception needs an expiry date');
      }
      return this.store.decideException(workspaceId, id, input.userId, { approve: true, note: input.note, expiresAt: input.expiresAt });
    }
    return this.store.decideException(workspaceId, id, input.userId, { approve: false, note: input.note });
  }

  revokeException(workspaceId: string, id: string, userId: string, note: string): ExceptionRecord {
    return this.store.revokeException(workspaceId, id, userId, note);
  }

  /** Marks approved exceptions past their date as expired and returns them. */
  expireDue(now = nowIso()): ExceptionRecord[] {
    return this.store.expireExceptionRecords(now);
  }

  // ---------------------------------------------------------------- share links (adapters over ProductStore)

  /**
   * Creates a read-only link for an auditor over every current rule (approved or retired). The
   * token is returned once; only its SHA-256 is kept.
   */
  createShare(input: { workspaceId: string; label: string; periodFrom: string; periodTo: string; expiresAt: string; createdBy: string; ruleIds?: string[] }): { token: string; record: ShareRecord } {
    const ruleIds = input.ruleIds?.length ? input.ruleIds : this.store.currentRuleIds(input.workspaceId);
    if (ruleIds.length === 0) throw new StoreError('approve a rule before sharing evidence');
    const { token, share } = this.store.createShare({
      workspaceId: input.workspaceId,
      label: input.label.trim() || 'Evidence',
      ruleIds,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    });
    return { token, record: share };
  }

  getShare(workspaceId: string, id: string): ShareRecord | undefined {
    return this.store.getShare(workspaceId, id);
  }

  listShares(workspaceId: string): ShareRecord[] {
    return this.store.listShares(workspaceId);
  }

  /** Revoking twice is harmless here: the already-revoked link comes back. */
  revokeShare(workspaceId: string, id: string): ShareRecord {
    const s = this.store.getShare(workspaceId, id);
    if (!s) throw new StoreError('share link not found', 404);
    return s.revokedAt ? s : this.store.revokeShare(workspaceId, id);
  }

  /** The share behind a token, only while it is active. */
  shareByToken(token: string): ShareRecord | undefined {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
    return this.store.shareByToken(token) ?? undefined;
  }

  logShareView(shareId: string, ip: string | null, userAgent: string | null): void {
    this.store.recordShareView(shareId, ip, userAgent);
  }

  listShareViews(shareId: string, limit = 20): Array<{ at: string; ip: string | null; userAgent: string | null }> {
    return this.store.listShareViews(shareId).slice(0, limit);
  }

  // ---------------------------------------------------------------- scans, for the dashboard and assistants

  /** The newest finished scan of a repository's default branch (not a pull request, not a baseline). */
  latestBranchScan(repoId: string, withFacts = false): BranchScan | undefined {
    const s = this.store.latestCheckedBranchScan(repoId);
    if (!s) return undefined;
    return { id: s.id, repoId: s.repoId, commitSha: s.commitSha, finishedAt: s.finishedAt, conclusion: s.conclusion, facts: withFacts ? s.facts : null };
  }

  /** The newest scan of each pull request in a repository. */
  latestPullRequestScans(repoId: string): Array<{ scanId: string; prNumber: number; commitSha: string; baseSha: string | null; conclusion: string | null; status: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.pr_number, s.commit_sha, s.base_sha, s.conclusion, s.status, s.created_at FROM scans s
         WHERE s.repo_id = ? AND s.pr_number IS NOT NULL AND s.created_at = (
           SELECT MAX(created_at) FROM scans t WHERE t.repo_id = s.repo_id AND t.pr_number = s.pr_number)
         ORDER BY s.pr_number DESC`
      )
      .all(repoId) as Row[];
    return rows.map((r) => ({
      scanId: String(r.id),
      prNumber: Number(r.pr_number),
      commitSha: String(r.commit_sha),
      baseSha: str(r.base_sha),
      conclusion: str(r.conclusion),
      status: String(r.status),
      createdAt: String(r.created_at),
    }));
  }

  scanIdForCheckRun(checkRunId: number): string | undefined {
    const r = this.db.prepare('SELECT id FROM scans WHERE check_run_id = ? ORDER BY created_at DESC LIMIT 1').get(checkRunId) as Row | undefined;
    return r ? String(r.id) : undefined;
  }

  /** The newest stored finding with this fingerprint in the workspace, with its rule and scan. */
  findingByFingerprint(workspaceId: string, fingerprint: string): {
    ruleId: string;
    ruleKey: string;
    ruleVersionId: string;
    repoId: string;
    repoFullName: string;
    scanId: string;
    prNumber: number | null;
    filePath: string;
    startLine: number;
    message: string;
    state: string;
  } | undefined {
    const r = this.db
      .prepare(
        `SELECT f.*, v.rule_id, s.repo_id, s.pr_number, rp.full_name FROM findings f
         JOIN scans s ON s.id = f.scan_id JOIN repos rp ON rp.id = s.repo_id JOIN rule_versions v ON v.id = f.rule_version_id
         WHERE rp.workspace_id = ? AND f.fingerprint = ? ORDER BY s.created_at DESC LIMIT 1`
      )
      .get(workspaceId, fingerprint) as Row | undefined;
    return r
      ? {
          ruleId: String(r.rule_id),
          ruleKey: String(r.rule_key),
          ruleVersionId: String(r.rule_version_id),
          repoId: String(r.repo_id),
          repoFullName: String(r.full_name),
          scanId: String(r.scan_id),
          prNumber: int(r.pr_number),
          filePath: String(r.file_path),
          startLine: Number(r.start_line),
          message: String(r.message),
          state: String(r.state),
        }
      : undefined;
  }

  /** Pull requests whose newest scan has a finding with this fingerprint. */
  pullRequestsWithFinding(repoId: string, fingerprint: string): number[] {
    return this.latestPullRequestScans(repoId)
      .filter((s) => this.db.prepare('SELECT 1 FROM findings WHERE scan_id = ? AND fingerprint = ? LIMIT 1').get(s.scanId, fingerprint))
      .map((s) => s.prNumber);
  }
}
