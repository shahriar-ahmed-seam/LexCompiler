import crypto from 'node:crypto';
import { nowIso, transaction, type Db } from '../db/index.js';
import { sha256Hex } from '../util/hash.js';
import { StoreError, type WorkspaceRole } from './store.js';

/**
 * Tables for the governance features: sign-in accounts, assistant tokens and their MCP calls,
 * exceptions, and share links. Like ProductStore, it keeps all SQL in one place.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const int = (v: unknown): number | null => (v == null ? null : Number(v));
const newId = () => crypto.randomUUID();
const DAY_MS = 86_400_000;

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

export type ExceptionStatus = 'requested' | 'approved' | 'rejected' | 'expired' | 'revoked';
export interface ExceptionRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  ruleKey: string | null;
  ruleTitle: string | null;
  repoId: string | null;
  repoFullName: string | null;
  fingerprint: string | null;
  pathGlob: string | null;
  filePath: string | null;
  startLine: number | null;
  message: string | null;
  reason: string;
  requestedBy: string;
  requesterLabel: string | null;
  requestedFrom: string | null;
  requestedAt: string;
  prNumber: number | null;
  scanId: string | null;
  status: ExceptionStatus;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
}

export interface ShareRecord {
  id: string;
  workspaceId: string;
  label: string | null;
  periodFrom: string;
  periodTo: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  lastViewedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface BranchScan {
  id: string;
  repoId: string;
  commitSha: string;
  finishedAt: string | null;
  conclusion: string | null;
  facts: { sqlTables: unknown[]; astFindings: unknown[] } | null;
}

export class GovernanceStore {
  constructor(readonly db: Db) {}

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

  // ---------------------------------------------------------------- assistant tokens

  private tokenFrom(r: Row): ApiTokenRecord {
    const revokedAt = str(r.revoked_at);
    const expiresAt = String(r.expires_at);
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      userId: String(r.user_id),
      userName: str(r.user_name),
      name: String(r.name),
      hint: String(r.token_hint),
      createdAt: String(r.created_at),
      expiresAt,
      lastUsedAt: str(r.last_used_at),
      lastClient: str(r.last_client),
      revokedAt,
      status: revokedAt ? 'revoked' : expiresAt <= nowIso() ? 'expired' : 'active',
    };
  }

  /** Creates a token. The secret is returned once and only its SHA-256 is kept. */
  createToken(input: { workspaceId: string; userId: string; name: string; days: number }): { token: string; record: ApiTokenRecord } {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new StoreError('a token needs a name');
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) throw new StoreError('tokens expire after 1 to 365 days');
    const token = `lexc_pat_${crypto.randomBytes(32).toString('base64url')}`;
    const id = newId();
    const now = new Date();
    this.db
      .prepare('INSERT INTO api_tokens (id, workspace_id, user_id, name, token_sha256, token_hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.workspaceId, input.userId, name, sha256Hex(token), token.slice(-4), now.toISOString(), new Date(now.getTime() + input.days * DAY_MS).toISOString());
    return { token, record: this.getToken(input.workspaceId, id)! };
  }

  getToken(workspaceId: string, tokenId: string): ApiTokenRecord | undefined {
    const r = this.db
      .prepare('SELECT t.*, u.name AS user_name FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.workspace_id = ?')
      .get(tokenId, workspaceId) as Row | undefined;
    return r ? this.tokenFrom(r) : undefined;
  }

  /** A person's tokens, or every token in the workspace when `userId` is null. */
  listTokens(workspaceId: string, userId: string | null): ApiTokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, u.name AS user_name FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.workspace_id = ? AND (? IS NULL OR t.user_id = ?) ORDER BY t.created_at DESC`
      )
      .all(workspaceId, userId, userId) as Row[];
    return rows.map((r) => this.tokenFrom(r));
  }

  revokeToken(workspaceId: string, tokenId: string, actor: { userId: string; canRevokeOthers: boolean }): ApiTokenRecord {
    const t = this.getToken(workspaceId, tokenId);
    if (!t) throw new StoreError('token not found', 404);
    if (t.userId !== actor.userId && !actor.canRevokeOthers) throw new StoreError('only the token owner or a workspace owner can revoke it', 403);
    if (!t.revokedAt) this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), tokenId);
    return this.getToken(workspaceId, tokenId)!;
  }

  /** Resolves a bearer token to its person, workspace and current role; null when unknown, expired, revoked or no longer a member. */
  authenticateToken(secret: string): { token: ApiTokenRecord; user: { id: string; sub: string; email: string | null; name: string | null }; role: WorkspaceRole } | null {
    if (!secret.startsWith('lexc_pat_') || secret.length > 200) return null;
    const r = this.db
      .prepare(
        `SELECT t.*, u.name AS user_name, u.oidc_sub, u.email, m.role FROM api_tokens t
         JOIN users u ON u.id = t.user_id
         JOIN workspaces w ON w.id = t.workspace_id
         LEFT JOIN memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
         WHERE t.token_sha256 = ? AND w.archived_at IS NULL`
      )
      .get(sha256Hex(secret)) as Row | undefined;
    if (!r || !r.role) return null;
    const token = this.tokenFrom(r);
    if (token.status !== 'active') return null;
    const now = Date.now();
    if (!token.lastUsedAt || now - Date.parse(token.lastUsedAt) > 60_000) {
      this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), token.id);
    }
    return { token, user: { id: token.userId, sub: String(r.oidc_sub), email: str(r.email), name: token.userName }, role: r.role as WorkspaceRole };
  }

  setTokenClient(tokenId: string, client: string): void {
    this.db.prepare('UPDATE api_tokens SET last_client = ? WHERE id = ?').run(client.slice(0, 80), tokenId);
  }

  // ---------------------------------------------------------------- MCP calls

  logMcpCall(input: { workspaceId: string; tokenId: string | null; userId: string | null; client: string | null; method: string; tool?: string | null; repo?: string | null; outcome: string; summary?: string | null; durationMs: number }): void {
    this.db
      .prepare(
        'INSERT INTO mcp_calls (id, workspace_id, token_id, user_id, client, method, tool, repo, outcome, summary, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        newId(),
        input.workspaceId,
        input.tokenId,
        input.userId,
        input.client?.slice(0, 80) ?? null,
        input.method.slice(0, 80),
        input.tool?.slice(0, 80) ?? null,
        input.repo?.slice(0, 200) ?? null,
        input.outcome.slice(0, 40),
        input.summary?.slice(0, 500) ?? null,
        Math.round(input.durationMs),
        nowIso()
      );
  }

  listMcpCalls(workspaceId: string, limit = 50): McpCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, u.name AS user_name FROM mcp_calls c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.workspace_id = ? AND c.tool IS NOT NULL ORDER BY c.created_at DESC LIMIT ?`
      )
      .all(workspaceId, Math.min(Math.max(limit, 1), 500)) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      userId: str(r.user_id),
      userName: str(r.user_name),
      client: str(r.client),
      method: String(r.method),
      tool: str(r.tool),
      repo: str(r.repo),
      outcome: String(r.outcome),
      summary: str(r.summary),
      durationMs: Number(r.duration_ms),
      createdAt: String(r.created_at),
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

  // ---------------------------------------------------------------- exceptions

  private exceptionFrom(r: Row): ExceptionRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      ruleId: String(r.rule_id),
      ruleKey: str(r.rule_key),
      ruleTitle: str(r.rule_title),
      repoId: str(r.repo_id),
      repoFullName: str(r.repo_full_name),
      fingerprint: str(r.fingerprint),
      pathGlob: str(r.path_glob),
      filePath: str(r.file_path),
      startLine: int(r.start_line),
      message: str(r.message),
      reason: String(r.reason),
      requestedBy: String(r.requested_by),
      requesterLabel: str(r.requester_label),
      requestedFrom: str(r.requested_from),
      requestedAt: String(r.requested_at),
      prNumber: int(r.pr_number),
      scanId: str(r.scan_id),
      status: r.status as ExceptionStatus,
      decidedBy: str(r.decided_by),
      decidedByName: str(r.decided_by_name),
      decidedAt: str(r.decided_at),
      decisionNote: str(r.decision_note),
      expiresAt: str(r.expires_at),
    };
  }

  private exceptionQuery(where: string): string {
    return `SELECT e.*, r.title AS rule_title, COALESCE(e.rule_key, r.key) AS rule_key, rp.full_name AS repo_full_name, d.name AS decided_by_name
            FROM exceptions e JOIN rules r ON r.id = e.rule_id
            LEFT JOIN repos rp ON rp.id = e.repo_id
            LEFT JOIN users d ON d.id = e.decided_by
            WHERE ${where}`;
  }

  getException(workspaceId: string, id: string): ExceptionRecord | undefined {
    const r = this.db.prepare(this.exceptionQuery('e.id = ? AND e.workspace_id = ?')).get(id, workspaceId) as Row | undefined;
    return r ? this.exceptionFrom(r) : undefined;
  }

  listExceptions(workspaceId: string, statuses?: ExceptionStatus[]): ExceptionRecord[] {
    const filter = statuses?.length ? ` AND e.status IN (${statuses.map(() => '?').join(', ')})` : '';
    const rows = this.db.prepare(`${this.exceptionQuery(`e.workspace_id = ?${filter}`)} ORDER BY e.requested_at DESC`).all(workspaceId, ...(statuses ?? [])) as Row[];
    return rows.map((r) => this.exceptionFrom(r));
  }

  /** Records a request. A finding with a pending or active exception gets that one back instead of a second. */
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
    requestedFrom: 'github' | 'mcp' | 'dashboard';
    prNumber?: number | null;
    scanId?: string | null;
    expiresAt?: string | null;
  }): { record: ExceptionRecord; created: boolean } {
    const reason = input.reason.trim().slice(0, 2000);
    if (!reason) throw new StoreError('a reason is required');
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT id FROM exceptions WHERE workspace_id = ? AND rule_id = ? AND fingerprint = ? AND (repo_id IS ? OR repo_id = ?)
           AND (status = 'requested' OR (status = 'approved' AND (expires_at IS NULL OR expires_at > ?)))
           ORDER BY requested_at DESC LIMIT 1`
        )
        .get(input.workspaceId, input.ruleId, input.fingerprint, input.repoId, input.repoId, nowIso()) as Row | undefined;
      if (existing) return { record: this.getException(input.workspaceId, String(existing.id))!, created: false };
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO exceptions (id, workspace_id, rule_id, repo_id, fingerprint, path_glob, reason, requested_by, requested_from, requested_at, status, expires_at,
             rule_key, scan_id, pr_number, file_path, start_line, message, requester_label)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.workspaceId,
          input.ruleId,
          input.repoId,
          input.fingerprint,
          reason,
          input.requestedBy,
          input.requestedFrom,
          nowIso(),
          input.expiresAt ?? null,
          input.ruleKey,
          input.scanId ?? null,
          input.prNumber ?? null,
          input.filePath,
          input.startLine,
          input.message.slice(0, 2000),
          input.requesterLabel.slice(0, 200)
        );
      return { record: this.getException(input.workspaceId, id)!, created: true };
    });
  }

  /** Legal's decision. Approval needs an expiry date in the future. */
  decideException(workspaceId: string, id: string, input: { decision: 'approved' | 'rejected'; userId: string; note: string; expiresAt?: string | null }): ExceptionRecord {
    const e = this.getException(workspaceId, id);
    if (!e) throw new StoreError('exception not found', 404);
    if (e.status !== 'requested') throw new StoreError(`only open requests can be decided (this one is ${e.status})`, 409);
    let expiresAt: string | null = null;
    if (input.decision === 'approved') {
      const t = Date.parse(String(input.expiresAt || ''));
      if (!Number.isFinite(t)) throw new StoreError('an approved exception needs an expiry date');
      if (t <= Date.now()) throw new StoreError('the expiry date must be in the future');
      if (t > Date.now() + 366 * DAY_MS) throw new StoreError('exceptions last at most a year');
      expiresAt = new Date(t).toISOString();
    }
    this.db
      .prepare('UPDATE exceptions SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, expires_at = ? WHERE id = ?')
      .run(input.decision, input.userId, nowIso(), input.note.trim().slice(0, 2000) || null, expiresAt, id);
    return this.getException(workspaceId, id)!;
  }

  revokeException(workspaceId: string, id: string, userId: string, note: string): ExceptionRecord {
    const e = this.getException(workspaceId, id);
    if (!e) throw new StoreError('exception not found', 404);
    if (e.status !== 'approved') throw new StoreError(`only approved exceptions can be revoked (this one is ${e.status})`, 409);
    this.db
      .prepare("UPDATE exceptions SET status = 'revoked', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
      .run(userId, nowIso(), note.trim().slice(0, 2000) || e.decisionNote, id);
    return this.getException(workspaceId, id)!;
  }

  /** Marks approved exceptions past their date as expired and returns them. */
  expireDue(now = nowIso()): ExceptionRecord[] {
    const rows = this.db.prepare(this.exceptionQuery("e.status = 'approved' AND e.expires_at IS NOT NULL AND e.expires_at <= ?")).all(now) as Row[];
    const due = rows.map((r) => this.exceptionFrom(r));
    for (const e of due) this.db.prepare("UPDATE exceptions SET status = 'expired' WHERE id = ? AND status = 'approved'").run(e.id);
    return due.map((e) => ({ ...e, status: 'expired' as const }));
  }

  // ---------------------------------------------------------------- share links

  private shareFrom(r: Row): ShareRecord {
    const revokedAt = str(r.revoked_at);
    const expiresAt = String(r.expires_at);
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      label: str(r.label),
      periodFrom: String(r.period_from),
      periodTo: String(r.period_to),
      createdBy: String(r.created_by),
      createdByName: str(r.created_by_name),
      createdAt: String(r.created_at),
      expiresAt,
      revokedAt,
      views: Number(r.views ?? 0),
      lastViewedAt: str(r.last_viewed_at),
      status: revokedAt ? 'revoked' : expiresAt <= nowIso() ? 'expired' : 'active',
    };
  }

  private shareQuery(where: string): string {
    return `SELECT s.*, u.name AS created_by_name, (SELECT COUNT(*) FROM share_views v WHERE v.share_id = s.id) AS views,
              (SELECT MAX(at) FROM share_views v WHERE v.share_id = s.id) AS last_viewed_at
            FROM shares s LEFT JOIN users u ON u.id = s.created_by WHERE ${where}`;
  }

  /** Creates a read-only link for an auditor. The token is returned once; only its SHA-256 is kept. */
  createShare(input: { workspaceId: string; label: string; periodFrom: string; periodTo: string; expiresAt: string; createdBy: string }): { token: string; record: ShareRecord } {
    const from = Date.parse(input.periodFrom);
    const to = Date.parse(input.periodTo);
    const expires = Date.parse(input.expiresAt);
    if (![from, to, expires].every(Number.isFinite)) throw new StoreError('period and expiry must be dates');
    if (to < from) throw new StoreError('the period ends before it starts');
    if (expires <= Date.now()) throw new StoreError('the link must expire in the future');
    if (expires > Date.now() + 90 * DAY_MS) throw new StoreError('share links last at most 90 days');
    const token = crypto.randomBytes(32).toString('base64url');
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO shares (id, workspace_id, token_sha256, label, counterparty_id, rule_ids_json, period_from, period_to, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, NULL, '[]', ?, ?, ?, ?, ?)`
      )
      .run(id, input.workspaceId, sha256Hex(token), input.label.trim().slice(0, 120) || 'Evidence', new Date(from).toISOString(), new Date(to).toISOString(), input.createdBy, nowIso(), new Date(expires).toISOString());
    return { token, record: this.getShare(input.workspaceId, id)! };
  }

  getShare(workspaceId: string, id: string): ShareRecord | undefined {
    const r = this.db.prepare(this.shareQuery('s.id = ? AND s.workspace_id = ?')).get(id, workspaceId) as Row | undefined;
    return r ? this.shareFrom(r) : undefined;
  }

  listShares(workspaceId: string): ShareRecord[] {
    return (this.db.prepare(`${this.shareQuery('s.workspace_id = ?')} ORDER BY s.created_at DESC`).all(workspaceId) as Row[]).map((r) => this.shareFrom(r));
  }

  revokeShare(workspaceId: string, id: string): ShareRecord {
    const s = this.getShare(workspaceId, id);
    if (!s) throw new StoreError('share link not found', 404);
    if (!s.revokedAt) this.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(nowIso(), id);
    return this.getShare(workspaceId, id)!;
  }

  /** The share behind a token, only while it is active. */
  shareByToken(token: string): ShareRecord | undefined {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
    const r = this.db.prepare(this.shareQuery('s.token_sha256 = ?')).get(sha256Hex(token)) as Row | undefined;
    const share = r ? this.shareFrom(r) : undefined;
    return share?.status === 'active' ? share : undefined;
  }

  logShareView(shareId: string, ip: string | null, userAgent: string | null): void {
    this.db.prepare('INSERT INTO share_views (share_id, at, ip, user_agent) VALUES (?, ?, ?, ?)').run(shareId, nowIso(), ip?.slice(0, 64) ?? null, userAgent?.slice(0, 300) ?? null);
  }

  listShareViews(shareId: string, limit = 20): Array<{ at: string; ip: string | null; userAgent: string | null }> {
    return (this.db.prepare('SELECT at, ip, user_agent FROM share_views WHERE share_id = ? ORDER BY at DESC LIMIT ?').all(shareId, limit) as Row[]).map((r) => ({
      at: String(r.at),
      ip: str(r.ip),
      userAgent: str(r.user_agent),
    }));
  }

  // ---------------------------------------------------------------- scans, for the dashboard and assistants

  /** The newest finished scan of a repository's default branch (not a pull request, not a baseline). */
  latestBranchScan(repoId: string, withFacts = false): BranchScan | undefined {
    const r = this.db
      .prepare(
        `SELECT id, repo_id, commit_sha, finished_at, conclusion${withFacts ? ', facts_json' : ''} FROM scans
         WHERE repo_id = ? AND pr_number IS NULL AND trigger <> 'baseline' AND status = 'completed'
         ORDER BY finished_at DESC LIMIT 1`
      )
      .get(repoId) as Row | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      repoId: String(r.repo_id),
      commitSha: String(r.commit_sha),
      finishedAt: str(r.finished_at),
      conclusion: str(r.conclusion),
      facts: withFacts && r.facts_json ? (JSON.parse(String(r.facts_json)) as BranchScan['facts']) : null,
    };
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
