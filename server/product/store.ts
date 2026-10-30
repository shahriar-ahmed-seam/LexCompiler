import crypto from 'node:crypto';
import type { Principal, SessionStore } from '../auth/oidc.js';
import { nowIso, transaction, type Db } from '../db/index.js';
import { sha256Hex } from '../util/hash.js';
import type { LegalClause } from '../../shared/types.js';
import type { ActiveException, ClassifiedFinding } from './scanner.js';

export type WorkspaceRole = 'owner' | 'legal' | 'engineer' | 'viewer';
export const WORKSPACE_ROLES: WorkspaceRole[] = ['owner', 'legal', 'engineer', 'viewer'];

/**
 * Who can do what. Rule approval stays with Legal so the person who approves a rule is not
 * the person who merges code; auditors look for that separation.
 */
export const PERMISSIONS = {
  manageWorkspace: ['owner'],
  editRules: ['legal'],
  decideExceptions: ['legal'],
  requestExceptions: ['owner', 'legal', 'engineer'],
  runScans: ['owner', 'legal', 'engineer'],
  createShares: ['owner', 'legal'],
  view: ['owner', 'legal', 'engineer', 'viewer'],
} as const satisfies Record<string, readonly WorkspaceRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: WorkspaceRole | null, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly WorkspaceRole[]).includes(role);
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  oidcSub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}
export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}
export interface Member {
  userId: string;
  sub: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
}
export interface Repo {
  id: string;
  workspaceId: string | null;
  source: 'github' | 'local';
  installationId: number | null;
  githubRepoId: number | null;
  fullName: string;
  defaultBranch: string;
  localPath: string | null;
}
export type RuleVersionStatus = 'draft' | 'approved' | 'rejected' | 'retired';
export interface RuleScope {
  all?: boolean;
  counterpartyIds?: string[];
}
export interface RuleVersion {
  id: string;
  ruleId: string;
  version: number;
  status: RuleVersionStatus;
  documentId: string | null;
  sourceText: string;
  clause: LegalClause;
  clauseSha256: string;
  scope: RuleScope;
  answers: Record<string, unknown> | null;
  effectiveFrom: string | null;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
}
export interface Rule {
  id: string;
  workspaceId: string;
  key: string;
  title: string;
  createdAt: string;
  retiredAt: string | null;
  versions: RuleVersion[];
}
/** The approved version of a rule that applies at a point in time. */
export interface RuleInEffect {
  ruleId: string;
  ruleKey: string;
  versionId: string;
  version: number;
  clause: LegalClause;
  clauseSha256: string;
  scope: RuleScope;
}

export type ScanTrigger = 'pull_request' | 'push' | 'manual' | 'rerun' | 'baseline' | 'connect';
export type ScanStatus = 'queued' | 'in_progress' | 'completed' | 'failed';
export interface ScanRecord {
  id: string;
  repoId: string;
  repoFullName: string;
  commitSha: string;
  baseSha: string | null;
  trigger: ScanTrigger;
  prNumber: number | null;
  rulesSha256: string;
  ruleVersions: Array<{ ruleKey: string; versionId: string; version: number; clauseSha256: string }>;
  lexcompilerVersion: string;
  status: ScanStatus;
  conclusion: string | null;
  checkRunId: number | null;
  filesScanned: number | null;
  summary: ScanSummary | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ScanSummary {
  newCount: number;
  existingCount: number;
  waivedCount: number;
  undecidedRuleKeys: string[];
  perRule: Array<{ ruleKey: string; newCount: number; existingCount: number; waivedCount: number }>;
}
export interface StoredFinding extends ClassifiedFinding {
  id: string;
  scanId: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const newId = () => crypto.randomUUID();

/** Every product table, behind one class so callers never write SQL. */
export class ProductStore {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- users and sessions

  upsertUser(input: { sub: string; email?: string | null; emailVerified?: boolean; name?: string | null }): User {
    const now = nowIso();
    const existing = this.db.prepare('SELECT id FROM users WHERE oidc_sub = ?').get(input.sub) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          'UPDATE users SET email = COALESCE(?, email), email_verified = COALESCE(?, email_verified), name = COALESCE(?, name), last_seen_at = ? WHERE id = ?'
        )
        .run(input.email ?? null, input.emailVerified === undefined ? null : input.emailVerified ? 1 : 0, input.name ?? null, now, String(existing.id));
    } else {
      this.db
        .prepare('INSERT INTO users (id, oidc_sub, email, email_verified, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), input.sub, input.email ?? null, input.emailVerified ? 1 : 0, input.name ?? null, now, now);
    }
    return this.getUserBySub(input.sub)!;
  }

  getUserBySub(sub: string): User | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) as Row | undefined;
    return r ? { id: String(r.id), oidcSub: String(r.oidc_sub), email: str(r.email), emailVerified: Number(r.email_verified) === 1, name: str(r.name) } : undefined;
  }

  /** Stores a session and returns its id. Only the id's SHA-256 is written to the database. */
  createSession(principal: Principal, ttlMs: number): string {
    const sessionId = crypto.randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions (id_sha256, principal_json, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256Hex(sessionId), JSON.stringify(principal), nowIso(), new Date(Date.now() + ttlMs).toISOString());
    return sessionId;
  }

  sessionPrincipal(sessionId: string): Principal | null {
    const r = this.db.prepare('SELECT principal_json, expires_at FROM sessions WHERE id_sha256 = ?').get(sha256Hex(sessionId)) as
      | Row
      | undefined;
    if (!r) return null;
    if (String(r.expires_at) < nowIso()) {
      this.deleteSession(sessionId);
      return null;
    }
    return JSON.parse(String(r.principal_json)) as Principal;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_sha256 = ?').run(sha256Hex(sessionId));
  }

  purgeExpiredSessions(): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()).changes);
  }

  // ---------------------------------------------------------------- workspaces and members

  createWorkspace(name: string, ownerUserId: string | null, createdBy = ownerUserId ?? 'system'): Workspace {
    const clean = name.trim().slice(0, 120);
    if (!clean) throw new StoreError('name is required');
    const id = newId();
    const now = nowIso();
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, clean, createdBy, now);
      if (ownerUserId) {
        this.db
          .prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
          .run(id, ownerUserId, 'owner', now);
      }
    });
    return this.getWorkspace(id)!;
  }

  getWorkspace(id: string): Workspace | undefined {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: String(r.id), name: String(r.name), createdAt: String(r.created_at) } : undefined;
  }

  findWorkspaceByName(name: string): Workspace | undefined {
    const r = this.db.prepare('SELECT id FROM workspaces WHERE name = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1').get(name) as Row | undefined;
    return r ? this.getWorkspace(String(r.id)) : undefined;
  }

  listWorkspaces(): Workspace[] {
    return (this.db.prepare('SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY created_at').all() as Row[]).map((r) => this.getWorkspace(String(r.id))!);
  }

  listWorkspacesForUser(userId: string): Array<Workspace & { role: WorkspaceRole }> {
    const rows = this.db
      .prepare(
        'SELECT w.id, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? AND w.archived_at IS NULL ORDER BY w.created_at'
      )
      .all(userId) as Row[];
    return rows.map((r) => ({ ...this.getWorkspace(String(r.id))!, role: r.role as WorkspaceRole }));
  }

  roleOf(workspaceId: string, userId: string): WorkspaceRole | null {
    const r = this.db.prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId) as
      | Row
      | undefined;
    return r ? (r.role as WorkspaceRole) : null;
  }

  listMembers(workspaceId: string): Member[] {
    const rows = this.db
      .prepare(
        'SELECT u.id, u.oidc_sub, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at'
      )
      .all(workspaceId) as Row[];
    return rows.map((r) => ({ userId: String(r.id), sub: String(r.oidc_sub), email: str(r.email), name: str(r.name), role: r.role as WorkspaceRole }));
  }

  setMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): void {
    if (!WORKSPACE_ROLES.includes(role)) throw new StoreError(`unknown role ${role}`);
    transaction(this.db, () => {
      const current = this.roleOf(workspaceId, userId);
      if (current === 'owner' && role !== 'owner') this.assertAnotherOwner(workspaceId, userId);
      this.db
        .prepare(
          'INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role'
        )
        .run(workspaceId, userId, role, nowIso());
    });
  }

  removeMember(workspaceId: string, userId: string): void {
    transaction(this.db, () => {
      if (this.roleOf(workspaceId, userId) === 'owner') this.assertAnotherOwner(workspaceId, userId);
      this.db.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
    });
  }

  private assertAnotherOwner(workspaceId: string, userId: string): void {
    const others = this.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner' AND user_id <> ?")
      .get(workspaceId, userId) as Row;
    if (Number(others.n) === 0) throw new StoreError('a workspace needs at least one owner');
  }

  /** Invites by email; the membership is created at the person's first sign-in. */
  invite(workspaceId: string, email: string, role: WorkspaceRole, invitedBy: string): { id: string; email: string; role: WorkspaceRole } {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(clean)) throw new StoreError('a valid email is required');
    if (!WORKSPACE_ROLES.includes(role)) throw new StoreError(`unknown role ${role}`);
    // Only a verified email identifies a person; anyone can put any address in an unverified claim.
    const existingUser = this.db.prepare('SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1').get(clean) as Row | undefined;
    if (existingUser) {
      this.setMemberRole(workspaceId, String(existingUser.id), role);
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO invitations (id, workspace_id, email, role, invited_by, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by, accepted_at = excluded.accepted_at`
      )
      .run(id, workspaceId, clean, role, invitedBy, nowIso(), existingUser ? nowIso() : null);
    return { id, email: clean, role };
  }

  listInvitations(workspaceId: string): Array<{ email: string; role: WorkspaceRole; acceptedAt: string | null }> {
    return (this.db.prepare('SELECT email, role, accepted_at FROM invitations WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Row[]).map(
      (r) => ({ email: String(r.email), role: r.role as WorkspaceRole, acceptedAt: str(r.accepted_at) })
    );
  }

  /** Turns pending invitations for the user's verified email into memberships. Returns how many. */
  acceptInvitations(user: User): number {
    if (!user.email || !user.emailVerified) return 0;
    const pending = this.db
      .prepare('SELECT workspace_id, role FROM invitations WHERE lower(email) = ? AND accepted_at IS NULL')
      .all(user.email.toLowerCase()) as Row[];
    for (const inv of pending) {
      if (!this.roleOf(String(inv.workspace_id), user.id)) {
        this.db
          .prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
          .run(String(inv.workspace_id), user.id, String(inv.role), nowIso());
      }
    }
    this.db.prepare('UPDATE invitations SET accepted_at = ? WHERE lower(email) = ? AND accepted_at IS NULL').run(nowIso(), user.email.toLowerCase());
    return pending.length;
  }

  // ---------------------------------------------------------------- repositories

  private repoFrom(r: Row): Repo {
    return {
      id: String(r.id),
      workspaceId: str(r.workspace_id),
      source: r.source as Repo['source'],
      installationId: r.installation_id == null ? null : Number(r.installation_id),
      githubRepoId: r.github_repo_id == null ? null : Number(r.github_repo_id),
      fullName: String(r.full_name),
      defaultBranch: String(r.default_branch),
      localPath: str(r.local_path),
    };
  }

  addLocalRepo(workspaceId: string, name: string, localPath: string): Repo {
    const id = newId();
    this.db
      .prepare('INSERT INTO repos (id, workspace_id, source, full_name, default_branch, local_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, workspaceId, 'local', name.trim().slice(0, 200) || 'repository', 'main', localPath, nowIso());
    return this.getRepo(id)!;
  }

  getRepo(id: string): Repo | undefined {
    const r = this.db.prepare('SELECT * FROM repos WHERE id = ? AND removed_at IS NULL').get(id) as Row | undefined;
    return r ? this.repoFrom(r) : undefined;
  }

  getRepoByGithubId(githubRepoId: number): Repo | undefined {
    const r = this.db.prepare('SELECT * FROM repos WHERE github_repo_id = ? AND removed_at IS NULL').get(githubRepoId) as Row | undefined;
    return r ? this.repoFrom(r) : undefined;
  }

  listRepos(workspaceId: string): Repo[] {
    return (this.db.prepare('SELECT * FROM repos WHERE workspace_id = ? AND removed_at IS NULL ORDER BY created_at').all(workspaceId) as Row[]).map(
      (r) => this.repoFrom(r)
    );
  }

  /** Records a GitHub App installation (webhook `installation.created`). */
  upsertInstallation(input: { installationId: number; accountLogin: string; accountType: string }): void {
    this.db
      .prepare(
        `INSERT INTO github_installations (installation_id, account_login, account_type, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type, removed_at = NULL`
      )
      .run(input.installationId, input.accountLogin, input.accountType, nowIso());
  }

  getInstallation(installationId: number): { installationId: number; accountLogin: string; workspaceId: string | null; removedAt: string | null } | undefined {
    const r = this.db.prepare('SELECT * FROM github_installations WHERE installation_id = ?').get(installationId) as Row | undefined;
    return r
      ? { installationId: Number(r.installation_id), accountLogin: String(r.account_login), workspaceId: str(r.workspace_id), removedAt: str(r.removed_at) }
      : undefined;
  }

  listUnlinkedInstallations(): Array<{ installationId: number; accountLogin: string }> {
    return (this.db.prepare('SELECT installation_id, account_login FROM github_installations WHERE workspace_id IS NULL AND removed_at IS NULL').all() as Row[]).map(
      (r) => ({ installationId: Number(r.installation_id), accountLogin: String(r.account_login) })
    );
  }

  removeInstallation(installationId: number): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE github_installations SET removed_at = ? WHERE installation_id = ?').run(nowIso(), installationId);
      this.db.prepare('UPDATE repos SET removed_at = ? WHERE installation_id = ? AND removed_at IS NULL').run(nowIso(), installationId);
    });
  }

  /** Records a repository the installation can access. It joins the installation's workspace, if linked. */
  upsertGithubRepo(input: { installationId: number; githubRepoId: number; fullName: string; defaultBranch?: string }): Repo {
    const inst = this.getInstallation(input.installationId);
    const existing = this.db.prepare('SELECT id FROM repos WHERE github_repo_id = ?').get(input.githubRepoId) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          'UPDATE repos SET installation_id = ?, full_name = ?, default_branch = COALESCE(?, default_branch), workspace_id = COALESCE(?, workspace_id), removed_at = NULL WHERE id = ?'
        )
        .run(input.installationId, input.fullName, input.defaultBranch ?? null, inst?.workspaceId ?? null, String(existing.id));
      return this.getRepo(String(existing.id))!;
    }
    const id = newId();
    this.db
      .prepare(
        'INSERT INTO repos (id, workspace_id, source, installation_id, github_repo_id, full_name, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, inst?.workspaceId ?? null, 'github', input.installationId, input.githubRepoId, input.fullName, input.defaultBranch ?? 'main', nowIso());
    return this.getRepo(id)!;
  }

  removeGithubRepo(githubRepoId: number): void {
    this.db.prepare('UPDATE repos SET removed_at = ? WHERE github_repo_id = ? AND removed_at IS NULL').run(nowIso(), githubRepoId);
  }

  /** Links an installation (and its repositories) to a workspace. */
  linkInstallation(installationId: number, workspaceId: string): void {
    if (!this.getInstallation(installationId)) throw new StoreError(`unknown installation ${installationId}`, 404);
    transaction(this.db, () => {
      this.db.prepare('UPDATE github_installations SET workspace_id = ? WHERE installation_id = ?').run(workspaceId, installationId);
      this.db.prepare('UPDATE repos SET workspace_id = ? WHERE installation_id = ?').run(workspaceId, installationId);
    });
  }

  // ---------------------------------------------------------------- counterparties and documents

  createCounterparty(workspaceId: string, name: string): { id: string; name: string } {
    const clean = name.trim().slice(0, 120);
    if (!clean) throw new StoreError('name is required');
    const existing = this.db.prepare('SELECT id FROM counterparties WHERE workspace_id = ? AND name = ?').get(workspaceId, clean) as Row | undefined;
    if (existing) return { id: String(existing.id), name: clean };
    const id = newId();
    this.db.prepare('INSERT INTO counterparties (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, workspaceId, clean, nowIso());
    return { id, name: clean };
  }

  listCounterparties(workspaceId: string): Array<{ id: string; name: string; scope: Array<{ repoId: string; pathGlob: string }> }> {
    const rows = this.db.prepare('SELECT id, name FROM counterparties WHERE workspace_id = ? ORDER BY name').all(workspaceId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      scope: (this.db.prepare('SELECT repo_id, path_glob FROM counterparty_scope WHERE counterparty_id = ?').all(String(r.id)) as Row[]).map((s) => ({
        repoId: String(s.repo_id),
        pathGlob: String(s.path_glob),
      })),
    }));
  }

  setCounterpartyScope(workspaceId: string, counterpartyId: string, scope: Array<{ repoId: string; pathGlob: string }>): void {
    const cp = this.db.prepare('SELECT id FROM counterparties WHERE id = ? AND workspace_id = ?').get(counterpartyId, workspaceId);
    if (!cp) throw new StoreError('unknown counterparty', 404);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM counterparty_scope WHERE counterparty_id = ?').run(counterpartyId);
      for (const s of scope) {
        const repo = this.getRepo(s.repoId);
        if (!repo || repo.workspaceId !== workspaceId) throw new StoreError(`unknown repository ${s.repoId}`, 404);
        this.db
          .prepare('INSERT OR IGNORE INTO counterparty_scope (counterparty_id, repo_id, path_glob) VALUES (?, ?, ?)')
          .run(counterpartyId, s.repoId, s.pathGlob.trim() || '**');
      }
    });
  }

  addDocument(input: {
    workspaceId: string;
    counterpartyId?: string | null;
    kind?: 'contract' | 'regulation' | 'policy';
    title: string;
    language?: string | null;
    text: string;
    uploadedBy: string;
    supersedesId?: string | null;
  }): { id: string; fileSha256: string } {
    const id = newId();
    const fileSha256 = sha256Hex(input.text);
    this.db
      .prepare(
        'INSERT INTO documents (id, workspace_id, counterparty_id, kind, title, language, file_sha256, text, supersedes_id, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.workspaceId,
        input.counterpartyId ?? null,
        input.kind ?? 'contract',
        input.title.trim().slice(0, 200) || 'Untitled document',
        input.language ?? null,
        fileSha256,
        input.text,
        input.supersedesId ?? null,
        input.uploadedBy,
        nowIso()
      );
    return { id, fileSha256 };
  }

  listDocuments(workspaceId: string): Array<{ id: string; title: string; kind: string; counterpartyId: string | null; fileSha256: string; uploadedAt: string }> {
    return (
      this.db
        .prepare('SELECT id, title, kind, counterparty_id, file_sha256, uploaded_at FROM documents WHERE workspace_id = ? ORDER BY uploaded_at DESC')
        .all(workspaceId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      kind: String(r.kind),
      counterpartyId: str(r.counterparty_id),
      fileSha256: String(r.file_sha256),
      uploadedAt: String(r.uploaded_at),
    }));
  }

  getDocument(workspaceId: string, id: string): { id: string; title: string; text: string; counterpartyId: string | null; kind: string } | undefined {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Row | undefined;
    return r ? { id: String(r.id), title: String(r.title), text: String(r.text), counterpartyId: str(r.counterparty_id), kind: String(r.kind) } : undefined;
  }

  // ---------------------------------------------------------------- rules

  private versionFrom(r: Row): RuleVersion {
    return {
      id: String(r.id),
      ruleId: String(r.rule_id),
      version: Number(r.version),
      status: r.status as RuleVersionStatus,
      documentId: str(r.document_id),
      sourceText: String(r.source_text),
      clause: JSON.parse(String(r.clause_json)) as LegalClause,
      clauseSha256: String(r.clause_sha256),
      scope: JSON.parse(String(r.scope_json)) as RuleScope,
      answers: r.answers_json ? (JSON.parse(String(r.answers_json)) as Record<string, unknown>) : null,
      effectiveFrom: str(r.effective_from),
      createdBy: String(r.created_by),
      createdAt: String(r.created_at),
      approvedBy: str(r.approved_by),
      approvedAt: str(r.approved_at),
      decisionNote: str(r.decision_note),
    };
  }

  nextRuleKey(workspaceId: string): string {
    const keys = (this.db.prepare('SELECT key FROM rules WHERE workspace_id = ?').all(workspaceId) as Row[]).map((r) => String(r.key));
    const max = keys.reduce((m, k) => Math.max(m, Number(/^R-(\d+)$/.exec(k)?.[1] ?? 0)), 0);
    return `R-${max + 1}`;
  }

  /**
   * Creates a draft version. Pass `ruleId` to add a version to an existing rule; otherwise a new
   * rule gets the next key (R-1, R-2, …). The clause is frozen as given.
   */
  createRuleDraft(input: {
    workspaceId: string;
    ruleId?: string;
    title: string;
    sourceText: string;
    clause: LegalClause;
    documentId?: string | null;
    scope?: RuleScope;
    createdBy: string;
  }): { rule: Rule; version: RuleVersion } {
    const versionId = transaction(this.db, () => {
      let ruleId = input.ruleId;
      let key: string;
      if (ruleId) {
        const rule = this.db.prepare('SELECT key FROM rules WHERE id = ? AND workspace_id = ?').get(ruleId, input.workspaceId) as Row | undefined;
        if (!rule) throw new StoreError('unknown rule', 404);
        key = String(rule.key);
      } else {
        ruleId = newId();
        key = this.nextRuleKey(input.workspaceId);
        this.db
          .prepare('INSERT INTO rules (id, workspace_id, key, title, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(ruleId, input.workspaceId, key, input.title.trim().slice(0, 200) || key, nowIso());
      }
      const last = this.db.prepare('SELECT MAX(version) AS v FROM rule_versions WHERE rule_id = ?').get(ruleId) as Row;
      const version = Number(last.v ?? 0) + 1;
      // The prover reports results by clause id, so the frozen clause carries the rule key.
      const clauseJson = JSON.stringify({ ...input.clause, id: key, title: input.title.trim() || input.clause.title });
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO rule_versions (id, rule_id, version, status, document_id, source_text, clause_json, clause_sha256, scope_json, created_by, created_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          ruleId,
          version,
          input.documentId ?? null,
          input.sourceText,
          clauseJson,
          sha256Hex(clauseJson),
          JSON.stringify(input.scope ?? { all: true }),
          input.createdBy,
          nowIso()
        );
      return id;
    });
    const version = this.getRuleVersion(input.workspaceId, versionId)!;
    return { rule: this.getRule(input.workspaceId, version.ruleId)!, version };
  }

  getRuleVersion(workspaceId: string, versionId: string): RuleVersion | undefined {
    const r = this.db
      .prepare('SELECT v.* FROM rule_versions v JOIN rules r ON r.id = v.rule_id WHERE v.id = ? AND r.workspace_id = ?')
      .get(versionId, workspaceId) as Row | undefined;
    return r ? this.versionFrom(r) : undefined;
  }

  getRule(workspaceId: string, ruleId: string): Rule | undefined {
    const r = this.db.prepare('SELECT * FROM rules WHERE id = ? AND workspace_id = ?').get(ruleId, workspaceId) as Row | undefined;
    if (!r) return undefined;
    const versions = (this.db.prepare('SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version').all(ruleId) as Row[]).map((v) =>
      this.versionFrom(v)
    );
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      key: String(r.key),
      title: String(r.title),
      createdAt: String(r.created_at),
      retiredAt: str(r.retired_at),
      versions,
    };
  }

  listRules(workspaceId: string): Rule[] {
    const ids = this.db.prepare('SELECT id FROM rules WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Row[];
    return ids
      .map((r) => this.getRule(workspaceId, String(r.id))!)
      .sort((a, b) => Number(a.key.slice(2)) - Number(b.key.slice(2)) || a.key.localeCompare(b.key));
  }

  /** Approves a draft. `approverUserId` must already be checked for the Legal role. */
  approveRuleVersion(workspaceId: string, versionId: string, approverUserId: string, options: { effectiveFrom?: string; answers?: Record<string, unknown>; note?: string } = {}): RuleVersion {
    const v = this.getRuleVersion(workspaceId, versionId);
    if (!v) throw new StoreError('unknown rule version', 404);
    if (v.status !== 'draft') throw new StoreError(`only drafts can be approved (this version is ${v.status})`, 409);
    const now = nowIso();
    const effectiveFrom = options.effectiveFrom ? new Date(options.effectiveFrom).toISOString() : now;
    this.db
      .prepare(
        "UPDATE rule_versions SET status = 'approved', approved_by = ?, approved_at = ?, effective_from = ?, answers_json = COALESCE(?, answers_json), decision_note = ? WHERE id = ?"
      )
      .run(approverUserId, now, effectiveFrom, options.answers ? JSON.stringify(options.answers) : null, options.note ?? null, versionId);
    this.db.prepare('UPDATE rules SET retired_at = NULL, retired_by = NULL WHERE id = ?').run(v.ruleId);
    return this.getRuleVersion(workspaceId, versionId)!;
  }

  rejectRuleVersion(workspaceId: string, versionId: string, userId: string, note: string): RuleVersion {
    const v = this.getRuleVersion(workspaceId, versionId);
    if (!v) throw new StoreError('unknown rule version', 404);
    if (v.status !== 'draft') throw new StoreError(`only drafts can be rejected (this version is ${v.status})`, 409);
    this.db
      .prepare("UPDATE rule_versions SET status = 'rejected', approved_by = ?, approved_at = ?, decision_note = ? WHERE id = ?")
      .run(userId, nowIso(), note.trim().slice(0, 2000) || null, versionId);
    return this.getRuleVersion(workspaceId, versionId)!;
  }

  /** Stops enforcing a rule from now on. Its approved versions stay in the history. */
  retireRule(workspaceId: string, ruleId: string, userId: string): void {
    const r = this.db.prepare('UPDATE rules SET retired_at = ?, retired_by = ? WHERE id = ? AND workspace_id = ?').run(nowIso(), userId, ruleId, workspaceId);
    if (Number(r.changes) === 0) throw new StoreError('unknown rule', 404);
  }

  /** For each rule, the latest approved version whose effective date has passed at `at`. */
  rulesInEffect(workspaceId: string, at: string = nowIso()): RuleInEffect[] {
    const rows = this.db
      .prepare(
        `SELECT r.id AS rule_id, r.key AS rule_key, v.* FROM rules r
         JOIN rule_versions v ON v.rule_id = r.id
         WHERE r.workspace_id = ? AND v.status = 'approved' AND COALESCE(v.effective_from, v.approved_at) <= ?
           AND (r.retired_at IS NULL OR r.retired_at > ?)
         ORDER BY r.id, COALESCE(v.effective_from, v.approved_at) DESC, v.version DESC`
      )
      .all(workspaceId, at, at) as Row[];
    const seen = new Set<string>();
    const out: RuleInEffect[] = [];
    for (const r of rows) {
      const ruleId = String(r.rule_id);
      if (seen.has(ruleId)) continue;
      seen.add(ruleId);
      const v = this.versionFrom(r);
      out.push({ ruleId, ruleKey: String(r.rule_key), versionId: v.id, version: v.version, clause: v.clause, clauseSha256: v.clauseSha256, scope: v.scope });
    }
    return out.sort((a, b) => Number(a.ruleKey.slice(2)) - Number(b.ruleKey.slice(2)));
  }

  // ---------------------------------------------------------------- scans and findings

  private scanFrom(r: Row): ScanRecord {
    return {
      id: String(r.id),
      repoId: String(r.repo_id),
      repoFullName: String(r.full_name ?? ''),
      commitSha: String(r.commit_sha),
      baseSha: str(r.base_sha),
      trigger: r.trigger as ScanTrigger,
      prNumber: r.pr_number == null ? null : Number(r.pr_number),
      rulesSha256: String(r.rules_sha256),
      ruleVersions: JSON.parse(String(r.rule_versions_json)),
      lexcompilerVersion: String(r.lexcompiler_version),
      status: r.status as ScanStatus,
      conclusion: str(r.conclusion),
      checkRunId: r.check_run_id == null ? null : Number(r.check_run_id),
      filesScanned: r.files_scanned == null ? null : Number(r.files_scanned),
      summary: r.summary_json ? (JSON.parse(String(r.summary_json)) as ScanSummary) : null,
      error: str(r.error),
      createdAt: String(r.created_at),
      startedAt: str(r.started_at),
      finishedAt: str(r.finished_at),
    };
  }

  createScan(input: {
    repoId: string;
    commitSha: string;
    baseSha?: string | null;
    trigger: ScanTrigger;
    prNumber?: number | null;
    rules: RuleInEffect[];
    lexcompilerVersion: string;
    jobId?: string | null;
  }): ScanRecord {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO scans (id, repo_id, commit_sha, base_sha, trigger, pr_number, rules_sha256, rule_versions_json, lexcompiler_version, status, created_at, started_at, job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`
      )
      .run(
        id,
        input.repoId,
        input.commitSha,
        input.baseSha ?? null,
        input.trigger,
        input.prNumber ?? null,
        rulesetSha256(input.rules),
        JSON.stringify(input.rules.map((r) => ({ ruleKey: r.ruleKey, versionId: r.versionId, version: r.version, clauseSha256: r.clauseSha256 }))),
        input.lexcompilerVersion,
        nowIso(),
        nowIso(),
        input.jobId ?? null
      );
    return this.getScanById(id)!;
  }

  /** The check run an earlier attempt of this job created, so a retry updates it instead of adding another. */
  previousCheckRunForJob(jobId: string): number | null {
    const r = this.db
      .prepare('SELECT check_run_id FROM scans WHERE job_id = ? AND check_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1')
      .get(jobId) as Row | undefined;
    return r ? Number(r.check_run_id) : null;
  }

  setScanCheckRun(scanId: string, checkRunId: number): void {
    this.db.prepare('UPDATE scans SET check_run_id = ? WHERE id = ?').run(checkRunId, scanId);
  }

  /** Stores the findings and marks the scan completed, in one transaction. */
  completeScan(scanId: string, input: { conclusion: string; filesScanned: number; summary: ScanSummary; facts?: unknown; findings: ClassifiedFinding[] }): ScanRecord {
    transaction(this.db, () => {
      const insert = this.db.prepare(
        `INSERT INTO findings (id, scan_id, rule_version_id, rule_key, fingerprint, file_path, start_line, end_line, construct_type, message, snippet, state, exception_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const f of input.findings) {
        insert.run(newId(), scanId, f.ruleVersionId, f.ruleKey, f.fingerprint, f.filePath, f.startLine, f.endLine, f.constructType, f.message, f.snippet.slice(0, 4000), f.state, f.exceptionId);
      }
      this.db
        .prepare("UPDATE scans SET status = 'completed', conclusion = ?, files_scanned = ?, summary_json = ?, facts_json = ?, finished_at = ? WHERE id = ?")
        .run(input.conclusion, input.filesScanned, JSON.stringify(input.summary), input.facts === undefined ? null : JSON.stringify(input.facts), nowIso(), scanId);
    });
    return this.getScanById(scanId)!;
  }

  failScan(scanId: string, error: string): void {
    this.db.prepare("UPDATE scans SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(error.slice(0, 2000), nowIso(), scanId);
  }

  getScanById(scanId: string): ScanRecord | undefined {
    const r = this.db.prepare('SELECT s.*, r.full_name FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?').get(scanId) as Row | undefined;
    return r ? this.scanFrom(r) : undefined;
  }

  /** A scan, only if it belongs to the workspace. */
  getScan(workspaceId: string, scanId: string): ScanRecord | undefined {
    const r = this.db
      .prepare('SELECT s.*, r.full_name FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id = ? AND r.workspace_id = ?')
      .get(scanId, workspaceId) as Row | undefined;
    return r ? this.scanFrom(r) : undefined;
  }

  listScans(workspaceId: string, options: { repoId?: string; limit?: number } = {}): ScanRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, r.full_name FROM scans s JOIN repos r ON r.id = s.repo_id
         WHERE r.workspace_id = ? AND (? IS NULL OR s.repo_id = ?)
         ORDER BY s.created_at DESC LIMIT ?`
      )
      .all(workspaceId, options.repoId ?? null, options.repoId ?? null, Math.min(Math.max(options.limit ?? 50, 1), 500)) as Row[];
    return rows.map((r) => this.scanFrom(r));
  }

  listFindings(scanId: string): StoredFinding[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, v.rule_id FROM findings f JOIN rule_versions v ON v.id = f.rule_version_id
         WHERE f.scan_id = ? ORDER BY f.file_path, f.start_line, f.rule_key`
      )
      .all(scanId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      scanId: String(r.scan_id),
      ruleId: String(r.rule_id),
      ruleKey: String(r.rule_key),
      ruleVersionId: String(r.rule_version_id),
      fingerprint: String(r.fingerprint),
      filePath: String(r.file_path),
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      constructType: String(r.construct_type ?? ''),
      message: String(r.message),
      snippet: String(r.snippet ?? ''),
      state: r.state as StoredFinding['state'],
      exceptionId: str(r.exception_id),
    }));
  }

  /** The latest completed scan of a commit against the same rule set, for reuse. */
  findCompletedScan(repoId: string, commitSha: string, rulesSha256: string): ScanRecord | undefined {
    const r = this.db
      .prepare(
        `SELECT s.*, r.full_name FROM scans s JOIN repos r ON r.id = s.repo_id
         WHERE s.repo_id = ? AND s.commit_sha = ? AND s.rules_sha256 = ? AND s.status = 'completed'
         ORDER BY s.finished_at DESC LIMIT 1`
      )
      .get(repoId, commitSha, rulesSha256) as Row | undefined;
    return r ? this.scanFrom(r) : undefined;
  }

  /** Approved exceptions that have not expired, for one repository. */
  activeExceptions(workspaceId: string, repoId: string, at: string = nowIso()): ActiveException[] {
    const rows = this.db
      .prepare(
        `SELECT id, rule_id, fingerprint, path_glob FROM exceptions
         WHERE workspace_id = ? AND status = 'approved' AND (repo_id IS NULL OR repo_id = ?) AND (expires_at IS NULL OR expires_at > ?)`
      )
      .all(workspaceId, repoId, at) as Row[];
    return rows.map((r) => ({ id: String(r.id), ruleId: String(r.rule_id), fingerprint: str(r.fingerprint), pathGlob: str(r.path_glob) }));
  }

  // ---------------------------------------------------------------- GitHub

  /** GitHub installations linked to a workspace, with their repositories. */
  listInstallationsForWorkspace(workspaceId: string): Array<{ installationId: number; accountLogin: string; accountType: string; repos: Repo[] }> {
    const rows = this.db
      .prepare('SELECT installation_id, account_login, account_type FROM github_installations WHERE workspace_id = ? AND removed_at IS NULL ORDER BY created_at')
      .all(workspaceId) as Row[];
    return rows.map((r) => ({
      installationId: Number(r.installation_id),
      accountLogin: String(r.account_login),
      accountType: String(r.account_type),
      repos: this.listRepos(workspaceId).filter((repo) => repo.installationId === Number(r.installation_id)),
    }));
  }

  /** Records a webhook delivery. Returns false when the delivery was already seen (a redelivery). */
  recordWebhookDelivery(deliveryId: string, event: string, action: string | null): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, received_at) VALUES (?, ?, ?, ?)')
      .run(deliveryId, event, action, nowIso());
    return Number(r.changes) === 1;
  }

  /**
   * Path globs a rule applies to in one repository: everything for workspace-wide rules, otherwise
   * the scope of the rule's counterparties in this repository (empty means the rule does not apply).
   */
  ruleScopeGlobs(scope: RuleScope, repoId: string): string[] {
    if (scope.all || !scope.counterpartyIds?.length) return ['**'];
    const placeholders = scope.counterpartyIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT DISTINCT path_glob FROM counterparty_scope WHERE repo_id = ? AND counterparty_id IN (${placeholders})`)
      .all(repoId, ...scope.counterpartyIds) as Row[];
    return rows.map((r) => String(r.path_glob));
  }
}

/** Identifies a set of rule versions; scans of the same commit with the same hash give the same result. */
export function rulesetSha256(rules: RuleInEffect[]): string {
  return sha256Hex(
    rules
      .map((r) => `${r.versionId}:${r.clauseSha256}`)
      .sort()
      .join('\n')
  );
}

/** Sessions for the OIDC provider, kept in the database so sign-ins survive restarts. */
export function databaseSessionStore(store: ProductStore): SessionStore {
  return {
    create: (principal, ttlMs) => store.createSession(principal, ttlMs),
    get: (sessionId) => store.sessionPrincipal(sessionId),
    delete: (sessionId) => store.deleteSession(sessionId),
  };
}
