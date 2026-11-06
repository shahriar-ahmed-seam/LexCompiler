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
  /** The rule card as Legal saw it (values, their sources, questions, AI suggestion). */
  card: Record<string, unknown> | null;
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
  /** When this version takes (or took) effect. */
  effectiveFrom?: string;
}

/** A regulation feed item (Phase 6), with whether this workspace drafted a rule from it. */
export interface FeedItem {
  id: string;
  source: 'EUR_LEX' | 'FEDERAL_REGISTER';
  documentNumber: string;
  title: string;
  publicationDate: string | null;
  agency: string | null;
  excerpt: string;
  url: string | null;
  kind: 'TEXT' | 'CHANGE_NOTICE';
  illustrative: boolean;
  firstSeenAt: string;
  /** The document this workspace made from the item, if any. */
  documentId?: string | null;
  /** Regulation watch's note for this workspace, if it ran. */
  watch?: FeedNote | null;
}

/** Regulation watch on one feed item, per workspace (server/product/regulationWatch.ts). */
export interface FeedNote {
  category: string | null;
  affectedRuleKeys: string[];
  summary: string | null;
  model: string | null;
  updatedAt: string;
}

/** What an approved, not-yet-effective version finds on a repository's default branch. */
export interface ComingUp {
  repoId: string;
  repoName: string;
  versionId: string;
  ruleKey: string;
  version: number;
  effectiveFrom: string;
  commitSha: string;
  computedAt: string;
  findings: Array<{ filePath: string; startLine: number; message: string; fingerprint: string }>;
}

export type ScanTrigger = 'pull_request' | 'push' | 'manual' | 'rerun' | 'baseline' | 'connect' | 'rule_approved' | 'scheduled';
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
/** A document without its text. */
export interface DocumentSummary {
  id: string;
  title: string;
  kind: string;
  counterpartyId: string | null;
  language: string | null;
  fileSha256: string;
  fileName: string | null;
  fileFormat: string;
  uploadedAt: string;
}

export type ExceptionStatus = 'requested' | 'approved' | 'rejected' | 'expired' | 'revoked';
/** Where a request came from: the check run's button, the dashboard, or a coding assistant over MCP. */
export type ExceptionSource = 'github' | 'dashboard' | 'assistant';
/** A request to waive findings of one rule: one fingerprint, or every finding under a path glob. */
export interface ExceptionRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  ruleKey: string;
  ruleTitle: string | null;
  repoId: string | null;
  repoName: string | null;
  /** Same as repoName (the name Shahriar's dashboard reads). */
  repoFullName: string | null;
  fingerprint: string | null;
  pathGlob: string | null;
  reason: string;
  /** A user id, or "github:<login>" for a request made with the check run's button. */
  requestedBy: string;
  /** How the requester is shown, e.g. "Tanvir Rahman via Kiro" or "@tanvir". */
  requesterLabel: string | null;
  requestedFrom: ExceptionSource;
  requestedAt: string;
  /** The end date the requester asked for; Legal sets the real one when approving. */
  requestedUntil: string | null;
  status: ExceptionStatus;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  scanId: string | null;
  prNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  filePath: string | null;
  startLine: number | null;
  message: string | null;
}

/** Personal access tokens for the MCP endpoint (product guide, Phase 4a). Only the SHA-256 is stored. */
export const API_TOKEN_PREFIX = 'lexc_pat_';
export const API_TOKEN_DEFAULT_DAYS = 90;
export interface ApiTokenRecord {
  id: string;
  workspaceId: string;
  userId: string;
  userName: string | null;
  name: string;
  /** The token's last four characters, for recognising it; null for tokens made before hints were kept. */
  hint: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** The MCP client name the token last connected with. */
  lastClient: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}
/** Who a token acts as: one user in one workspace, with that user's current role. */
export interface TokenPrincipal {
  tokenId: string;
  workspaceId: string;
  userId: string;
  userSub: string;
  role: WorkspaceRole;
}
export type McpCallOutcome = 'ok' | 'tool_error' | 'error' | 'denied' | 'rate_limited';
export interface McpCallRecord {
  id: string;
  workspaceId: string;
  tokenId: string | null;
  userId: string | null;
  userName: string | null;
  client: string | null;
  method: string;
  tool: string | null;
  repo: string | null;
  outcome: McpCallOutcome;
  /** One line of what happened, for the dashboard. */
  summary: string | null;
  durationMs: number;
  /** File paths and fingerprints only; sent code is never stored. */
  detail: Record<string, unknown> | null;
  createdAt: string;
}
/** What recordMcpCall takes: the person, client and summary are optional (the person defaults to the token's owner). */
export type McpCallInput = Omit<McpCallRecord, 'id' | 'createdAt' | 'userId' | 'userName' | 'client' | 'summary' | 'detail'> & {
  userId?: string | null;
  client?: string | null;
  summary?: string | null;
  detail?: Record<string, unknown> | null;
};

/** A read-only link for an auditor (product guide, Phase 5). Only the token's SHA-256 is stored. */
export const SHARE_TOKEN_PREFIX = 'lexc_share_';
export interface ShareRecord {
  id: string;
  workspaceId: string;
  label: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  ruleIds: string[];
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

/** The newest completed scan of a repository's default branch. */
export interface BranchScanRecord {
  id: string;
  repoId: string;
  commitSha: string;
  finishedAt: string | null;
  conclusion: string | null;
}

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

  getUserById(id: string): User | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
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
    /** The uploaded file; without one, the text is the document and its hash is the text's. */
    file?: { name: string; format: string; data: Buffer; sha256: string };
  }): { id: string; fileSha256: string } {
    const id = newId();
    const fileSha256 = input.file?.sha256 ?? sha256Hex(input.text);
    if (input.counterpartyId && !this.db.prepare('SELECT 1 FROM counterparties WHERE id = ? AND workspace_id = ?').get(input.counterpartyId, input.workspaceId)) {
      throw new StoreError('unknown counterparty', 404);
    }
    this.db
      .prepare(
        'INSERT INTO documents (id, workspace_id, counterparty_id, kind, title, language, file_sha256, text, supersedes_id, uploaded_by, uploaded_at, file_name, file_format, file_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        nowIso(),
        input.file?.name.slice(0, 200) ?? null,
        input.file?.format ?? 'text',
        input.file?.data ?? null
      );
    return { id, fileSha256 };
  }

  listDocuments(workspaceId: string): DocumentSummary[] {
    return (
      this.db
        .prepare('SELECT id, title, kind, counterparty_id, language, file_sha256, file_name, file_format, uploaded_at FROM documents WHERE workspace_id = ? ORDER BY uploaded_at DESC')
        .all(workspaceId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      kind: String(r.kind),
      counterpartyId: str(r.counterparty_id),
      language: str(r.language),
      fileSha256: String(r.file_sha256),
      fileName: str(r.file_name),
      fileFormat: str(r.file_format) ?? 'text',
      uploadedAt: String(r.uploaded_at),
    }));
  }

  getDocument(workspaceId: string, id: string): (DocumentSummary & { text: string }) | undefined {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Row | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      title: String(r.title),
      kind: String(r.kind),
      counterpartyId: str(r.counterparty_id),
      language: str(r.language),
      fileSha256: String(r.file_sha256),
      fileName: str(r.file_name),
      fileFormat: str(r.file_format) ?? 'text',
      uploadedAt: String(r.uploaded_at),
      text: String(r.text),
    };
  }

  /** The uploaded file as it was, or null for pasted text. */
  getDocumentFile(workspaceId: string, id: string): { name: string; format: string; data: Buffer } | null {
    const r = this.db.prepare('SELECT file_name, file_format, file_blob FROM documents WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Row | undefined;
    if (!r || r.file_blob == null) return null;
    return { name: String(r.file_name ?? 'document'), format: String(r.file_format ?? 'text'), data: Buffer.from(r.file_blob as Uint8Array) };
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
      card: r.card_json ? (JSON.parse(String(r.card_json)) as Record<string, unknown>) : null,
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
    card?: Record<string, unknown> | null;
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
          `INSERT INTO rule_versions (id, rule_id, version, status, document_id, source_text, clause_json, clause_sha256, scope_json, card_json, created_by, created_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
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
          input.card ? JSON.stringify(input.card) : null,
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
      out.push({ ruleId, ruleKey: String(r.rule_key), versionId: v.id, version: v.version, clause: v.clause, clauseSha256: v.clauseSha256, scope: v.scope, effectiveFrom: v.effectiveFrom ?? v.approvedAt ?? undefined });
    }
    return out.sort((a, b) => Number(a.ruleKey.slice(2)) - Number(b.ruleKey.slice(2)));
  }

  /**
   * Approved versions that take effect after `at` (the next one per rule). They don't fail pull
   * requests yet: checks show their findings as warnings, and "Coming up" lists them.
   */
  upcomingRules(workspaceId: string, at: string = nowIso()): RuleInEffect[] {
    const rows = this.db
      .prepare(
        `SELECT r.id AS rule_id, r.key AS rule_key, v.* FROM rules r
         JOIN rule_versions v ON v.rule_id = r.id
         WHERE r.workspace_id = ? AND v.status = 'approved' AND COALESCE(v.effective_from, v.approved_at) > ? AND r.retired_at IS NULL
         ORDER BY r.id, COALESCE(v.effective_from, v.approved_at), v.version`
      )
      .all(workspaceId, at) as Row[];
    const seen = new Set<string>();
    const out: RuleInEffect[] = [];
    for (const r of rows) {
      const ruleId = String(r.rule_id);
      if (seen.has(ruleId)) continue;
      seen.add(ruleId);
      const v = this.versionFrom(r);
      out.push({ ruleId, ruleKey: String(r.rule_key), versionId: v.id, version: v.version, clause: v.clause, clauseSha256: v.clauseSha256, scope: v.scope, effectiveFrom: v.effectiveFrom ?? undefined });
    }
    return out.sort((a, b) => Number(a.ruleKey.slice(2)) - Number(b.ruleKey.slice(2)));
  }

  /**
   * Moves the effective date of an approved version that hasn't taken effect yet (Legal). A date
   * today or earlier makes it take effect now.
   */
  setEffectiveFrom(workspaceId: string, versionId: string, effectiveFrom: string, now: Date = new Date()): RuleVersion {
    const v = this.getRuleVersion(workspaceId, versionId);
    if (!v) throw new StoreError('unknown rule version', 404);
    if (v.status !== 'approved') throw new StoreError('only approved versions have an effective date', 409);
    if ((v.effectiveFrom ?? v.approvedAt ?? '') <= now.toISOString()) throw new StoreError('this version is already in effect', 409);
    const at = new Date(effectiveFrom);
    if (Number.isNaN(at.getTime())) throw new StoreError('effectiveFrom must be a date');
    const value = at.getTime() <= now.getTime() ? now.toISOString() : at.toISOString();
    this.db.prepare('UPDATE rule_versions SET effective_from = ? WHERE id = ?').run(value, versionId);
    return this.getRuleVersion(workspaceId, versionId)!;
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
    return rows.map((r) => this.findingFrom(r));
  }

  /**
   * The most recent stored finding in a workspace, by fingerprint or by rule, file and a line
   * inside it. Used by the MCP tools for findings of PR checks and branch scans.
   */
  findStoredFinding(
    workspaceId: string,
    query: { fingerprint: string } | { ruleKey: string; filePath: string; line: number }
  ): (StoredFinding & { repoId: string; scan: { id: string; commitSha: string; prNumber: number | null; baseSha: string | null } }) | undefined {
    const where = 'fingerprint' in query ? 'f.fingerprint = ?' : 'f.rule_key = ? AND f.file_path = ? AND f.start_line <= ? AND f.end_line >= ?';
    const args = 'fingerprint' in query ? [query.fingerprint] : [query.ruleKey, query.filePath, query.line, query.line];
    const r = this.db
      .prepare(
        `SELECT f.*, v.rule_id, s.repo_id, s.commit_sha, s.pr_number, s.base_sha FROM findings f
         JOIN rule_versions v ON v.id = f.rule_version_id JOIN scans s ON s.id = f.scan_id JOIN repos p ON p.id = s.repo_id
         WHERE p.workspace_id = ? AND ${where} ORDER BY s.finished_at DESC LIMIT 1`
      )
      .get(workspaceId, ...args) as Row | undefined;
    if (!r) return undefined;
    return {
      ...this.findingFrom(r),
      repoId: String(r.repo_id),
      scan: { id: String(r.scan_id), commitSha: String(r.commit_sha), prNumber: r.pr_number == null ? null : Number(r.pr_number), baseSha: str(r.base_sha) },
    };
  }

  private findingFrom(r: Row): StoredFinding {
    return {
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
    };
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
        `SELECT id, rule_id, fingerprint, path_glob, expires_at FROM exceptions
         WHERE workspace_id = ? AND status = 'approved' AND (repo_id IS NULL OR repo_id = ?) AND (expires_at IS NULL OR expires_at > ?)`
      )
      .all(workspaceId, repoId, at) as Row[];
    return rows.map((r) => ({ id: String(r.id), ruleId: String(r.rule_id), fingerprint: str(r.fingerprint), pathGlob: str(r.path_glob), expiresAt: str(r.expires_at) }));
  }

  // ---------------------------------------------------------------- exceptions (Phase 4)

  private exceptionFrom(r: Row): ExceptionRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      ruleId: String(r.rule_id),
      ruleKey: String(r.effective_rule_key ?? r.rule_key ?? ''),
      ruleTitle: str(r.rule_title),
      repoId: str(r.repo_id),
      repoName: str(r.full_name),
      repoFullName: str(r.full_name),
      fingerprint: str(r.fingerprint),
      pathGlob: str(r.path_glob),
      reason: String(r.reason),
      requestedBy: String(r.requested_by),
      requesterLabel: str(r.requester_label),
      // Requests logged as 'mcp' before migration 17 read as 'assistant'.
      requestedFrom: (str(r.requested_from) === 'mcp' ? 'assistant' : (str(r.requested_from) ?? 'dashboard')) as ExceptionSource,
      requestedAt: String(r.requested_at),
      requestedUntil: str(r.requested_until),
      status: r.status as ExceptionStatus,
      decidedBy: str(r.decided_by),
      decidedByName: str(r.decided_by_name),
      decidedAt: str(r.decided_at),
      decisionNote: str(r.decision_note),
      expiresAt: str(r.expires_at),
      scanId: str(r.scan_id),
      prNumber: r.pr_number == null ? null : Number(r.pr_number),
      headSha: str(r.head_sha),
      baseSha: str(r.base_sha),
      filePath: str(r.file_path),
      startLine: r.start_line == null ? null : Number(r.start_line),
      message: str(r.message),
    };
  }

  /** The rule key stored with the request wins over the rule's (they only differ on old rows). */
  private static readonly EXCEPTION_SELECT = `SELECT e.*, COALESCE(e.rule_key, r.key) AS effective_rule_key, r.title AS rule_title, p.full_name, d.name AS decided_by_name
    FROM exceptions e JOIN rules r ON r.id = e.rule_id LEFT JOIN repos p ON p.id = e.repo_id LEFT JOIN users d ON d.id = e.decided_by`;

  /**
   * Records a request. A request for a finding that already has an open request or an
   * unexpired approval returns that one instead, so clicking the button twice adds nothing.
   */
  requestException(input: {
    workspaceId: string;
    ruleId: string;
    /** Defaults to the rule's key. */
    ruleKey?: string | null;
    repoId: string | null;
    fingerprint?: string | null;
    pathGlob?: string | null;
    reason: string;
    requestedBy: string;
    /** How the requester is shown (e.g. "Tanvir Rahman via Kiro"). */
    requesterLabel?: string | null;
    requestedFrom: ExceptionSource;
    requestedUntil?: string | null;
    scan?: { id: string; prNumber: number | null; headSha: string; baseSha: string | null } | null;
    /** The pull request, when it is known without a stored scan. */
    prNumber?: number | null;
    finding?: { filePath: string; startLine: number; message: string } | null;
  }): { exception: ExceptionRecord; created: boolean } {
    const fingerprint = input.fingerprint || null;
    const pathGlob = input.pathGlob?.trim() || null;
    if (!fingerprint === !pathGlob) throw new StoreError('an exception covers either one finding (fingerprint) or a path glob');
    const rule = this.db.prepare('SELECT key FROM rules WHERE id = ? AND workspace_id = ?').get(input.ruleId, input.workspaceId) as Row | undefined;
    if (!rule) throw new StoreError('unknown rule', 404);
    const ruleKey = input.ruleKey?.trim() || String(rule.key);
    const reason = input.reason.trim().slice(0, 2000);
    if (!reason) throw new StoreError('a reason is required');
    const now = nowIso();
    const existing = this.db
      .prepare(
        `SELECT id FROM exceptions WHERE workspace_id = ? AND rule_id = ? AND repo_id IS ? AND fingerprint IS ? AND path_glob IS ?
           AND (status = 'requested' OR (status = 'approved' AND (expires_at IS NULL OR expires_at > ?))) ORDER BY requested_at DESC LIMIT 1`
      )
      .get(input.workspaceId, input.ruleId, input.repoId, fingerprint, pathGlob, now) as Row | undefined;
    if (existing) return { exception: this.getException(input.workspaceId, String(existing.id))!, created: false };
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO exceptions (id, workspace_id, rule_id, repo_id, fingerprint, path_glob, reason, requested_by, requested_from, requested_at, status,
           scan_id, pr_number, head_sha, base_sha, file_path, start_line, message, requested_until, rule_key, requester_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.workspaceId,
        input.ruleId,
        input.repoId,
        fingerprint,
        pathGlob,
        reason,
        input.requestedBy,
        input.requestedFrom,
        now,
        input.scan?.id ?? null,
        input.scan?.prNumber ?? input.prNumber ?? null,
        input.scan?.headSha ?? null,
        input.scan?.baseSha ?? null,
        input.finding?.filePath ?? null,
        input.finding?.startLine ?? null,
        input.finding?.message.slice(0, 2000) ?? null,
        input.requestedUntil ?? null,
        ruleKey,
        input.requesterLabel?.trim().slice(0, 200) || null
      );
    return { exception: this.getException(input.workspaceId, id)!, created: true };
  }

  getException(workspaceId: string, id: string): ExceptionRecord | undefined {
    const r = this.db.prepare(`${ProductStore.EXCEPTION_SELECT} WHERE e.id = ? AND e.workspace_id = ?`).get(id, workspaceId) as Row | undefined;
    return r ? this.exceptionFrom(r) : undefined;
  }

  /** A workspace's exceptions, newest first; `status` is one status or several. */
  listExceptions(workspaceId: string, options: { status?: ExceptionStatus | ExceptionStatus[] } = {}): ExceptionRecord[] {
    const statuses = options.status === undefined ? [] : Array.isArray(options.status) ? options.status : [options.status];
    const filter = statuses.length ? ` AND e.status IN (${statuses.map(() => '?').join(', ')})` : '';
    const rows = this.db.prepare(`${ProductStore.EXCEPTION_SELECT} WHERE e.workspace_id = ?${filter} ORDER BY e.requested_at DESC`).all(workspaceId, ...statuses) as Row[];
    return rows.map((r) => this.exceptionFrom(r));
  }

  /** Legal's decision. Approval needs a reason and an expiry date in the future. */
  decideException(
    workspaceId: string,
    id: string,
    userId: string,
    decision: { approve: true; note: string; expiresAt: string } | { approve: false; note: string },
    now: Date = new Date()
  ): ExceptionRecord {
    const e = this.getException(workspaceId, id);
    if (!e) throw new StoreError('unknown exception', 404);
    if (e.status !== 'requested') throw new StoreError(`only requested exceptions can be decided (this one is ${e.status})`, 409);
    const note = decision.note.trim().slice(0, 2000);
    if (decision.approve) {
      if (!note) throw new StoreError('approving an exception needs a reason');
      const expires = new Date(decision.expiresAt);
      if (Number.isNaN(expires.getTime())) throw new StoreError('expiresAt must be a date');
      if (expires.getTime() <= now.getTime()) throw new StoreError('expiresAt must be in the future');
      if (expires.getTime() > now.getTime() + 366 * 24 * 3600 * 1000) throw new StoreError('an exception can last at most one year');
      this.db
        .prepare("UPDATE exceptions SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, expires_at = ? WHERE id = ?")
        .run(userId, now.toISOString(), note, expires.toISOString(), id);
    } else {
      this.db.prepare("UPDATE exceptions SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(userId, now.toISOString(), note || null, id);
    }
    return this.getException(workspaceId, id)!;
  }

  /** Test-only admin action (guide, Phase 4 test): moves an approved exception's expiry. */
  setExceptionExpiry(workspaceId: string, id: string, expiresAt: string): ExceptionRecord {
    const e = this.getException(workspaceId, id);
    if (!e) throw new StoreError('unknown exception', 404);
    if (e.status !== 'approved' && e.status !== 'expired') throw new StoreError('only approved exceptions have an expiry', 409);
    this.db.prepare("UPDATE exceptions SET expires_at = ?, status = 'approved' WHERE id = ?").run(new Date(expiresAt).toISOString(), id);
    return this.getException(workspaceId, id)!;
  }

  /** Legal withdraws an approved exception before it expires. The revoker becomes the deciding person. */
  revokeException(workspaceId: string, id: string, userId: string, note: string, now: Date = new Date()): ExceptionRecord {
    const e = this.getException(workspaceId, id);
    if (!e) throw new StoreError('unknown exception', 404);
    if (e.status !== 'approved') throw new StoreError(`only approved exceptions can be revoked (this one is ${e.status})`, 409);
    this.db
      .prepare("UPDATE exceptions SET status = 'revoked', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'approved'")
      .run(userId, now.toISOString(), note.trim().slice(0, 2000) || e.decisionNote, id);
    return this.getException(workspaceId, id)!;
  }

  /** Marks approved exceptions whose expiry has passed as expired; returns how many. Scans ignore them either way. */
  expireExceptions(at: string = nowIso()): number {
    return this.expireExceptionRecords(at).length;
  }

  /** As expireExceptions, returning the exceptions that just expired (for the evidence log). */
  expireExceptionRecords(at: string = nowIso()): ExceptionRecord[] {
    const ids = (this.db.prepare("SELECT id FROM exceptions WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?").all(at) as Row[]).map((r) => String(r.id));
    if (ids.length === 0) return [];
    this.db.prepare(`UPDATE exceptions SET status = 'expired' WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
    return ids.map((id) => this.exceptionFrom(this.db.prepare(`${ProductStore.EXCEPTION_SELECT} WHERE e.id = ?`).get(id) as Row));
  }

  /** The scan a check run reported, found from GitHub's check run id. */
  getScanByCheckRun(checkRunId: number): ScanRecord | undefined {
    const r = this.db
      .prepare('SELECT s.*, p.full_name FROM scans s JOIN repos p ON p.id = s.repo_id WHERE s.check_run_id = ? ORDER BY s.created_at DESC LIMIT 1')
      .get(checkRunId) as Row | undefined;
    return r ? this.scanFrom(r) : undefined;
  }

  /** The signed evidence record of a completed scan (Phase 5). */
  setScanEvidence(scanId: string, seq: number, headerSha256: string): void {
    this.db.prepare('UPDATE scans SET evidence_seq = ?, evidence_header_sha256 = ? WHERE id = ?').run(seq, headerSha256, scanId);
  }

  scanEvidence(scanId: string): { seq: number; headerSha256: string } | null {
    const r = this.db.prepare('SELECT evidence_seq, evidence_header_sha256 FROM scans WHERE id = ?').get(scanId) as Row | undefined;
    return r?.evidence_seq == null ? null : { seq: Number(r.evidence_seq), headerSha256: String(r.evidence_header_sha256) };
  }

  /** Completed scans (not baselines) of the given repositories that finished within the period, oldest first. */
  scansInPeriod(repoIds: string[], from: string, to: string): ScanRecord[] {
    if (repoIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT s.*, r.full_name FROM scans s JOIN repos r ON r.id = s.repo_id
         WHERE s.repo_id IN (${repoIds.map(() => '?').join(', ')}) AND s.status = 'completed' AND s.trigger <> 'baseline' AND s.finished_at >= ? AND s.finished_at <= ?
         ORDER BY s.finished_at`
      )
      .all(...repoIds, from, to) as Row[];
    return rows.map((r) => this.scanFrom(r));
  }

  // ---------------------------------------------------------------- coming up, regulation feed, schedules (Phase 6)

  /** Replaces what one upcoming version finds on one repository's default branch. */
  setComingUp(input: { workspaceId: string; repoId: string; versionId: string; commitSha: string; findings: ComingUp['findings'] }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO coming_up (workspace_id, repo_id, version_id, commit_sha, computed_at, findings_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.workspaceId, input.repoId, input.versionId, input.commitSha, nowIso(), JSON.stringify(input.findings));
  }

  /** Coming-up results for versions that are still upcoming; stale rows of versions now in effect are dropped. */
  listComingUp(workspaceId: string, at: string = nowIso()): ComingUp[] {
    const upcoming = new Map(this.upcomingRules(workspaceId, at).map((r) => [r.versionId, r]));
    const rows = this.db
      .prepare('SELECT c.*, p.full_name FROM coming_up c JOIN repos p ON p.id = c.repo_id WHERE c.workspace_id = ? ORDER BY p.full_name')
      .all(workspaceId) as Row[];
    return rows
      .filter((r) => upcoming.has(String(r.version_id)))
      .map((r) => {
        const rule = upcoming.get(String(r.version_id))!;
        return {
          repoId: String(r.repo_id),
          repoName: String(r.full_name),
          versionId: rule.versionId,
          ruleKey: rule.ruleKey,
          version: rule.version,
          effectiveFrom: rule.effectiveFrom ?? '',
          commitSha: String(r.commit_sha),
          computedAt: String(r.computed_at),
          findings: JSON.parse(String(r.findings_json)) as ComingUp['findings'],
        };
      })
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.ruleKey.localeCompare(b.ruleKey) || a.repoName.localeCompare(b.repoName));
  }

  /** Stores feed items not seen before; returns how many were new. */
  addFeedItems(items: Array<Omit<FeedItem, 'firstSeenAt' | 'documentId'>>): number {
    let added = 0;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO feed_items (id, source, document_number, title, publication_date, agency, excerpt, url, kind, illustrative, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    transaction(this.db, () => {
      for (const i of items) {
        added += Number(insert.run(i.id, i.source, i.documentNumber, i.title.slice(0, 1000), i.publicationDate, i.agency, i.excerpt.slice(0, 20000), i.url, i.kind, i.illustrative ? 1 : 0, nowIso()).changes);
      }
    });
    return added;
  }

  private feedItemFrom(r: Row): FeedItem {
    return {
      id: String(r.id),
      source: r.source as FeedItem['source'],
      documentNumber: String(r.document_number),
      title: String(r.title),
      publicationDate: str(r.publication_date),
      agency: str(r.agency),
      excerpt: String(r.excerpt),
      url: str(r.url),
      kind: r.kind as FeedItem['kind'],
      illustrative: Number(r.illustrative) === 1,
      firstSeenAt: String(r.first_seen_at),
      documentId: str(r.document_id),
    };
  }

  /** Feed items, newest first, with the document this workspace made from each (if any). */
  listFeedItems(workspaceId: string, limit = 100): FeedItem[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, (SELECT d.id FROM documents d WHERE d.feed_item_id = f.id AND d.workspace_id = ? ORDER BY d.uploaded_at DESC LIMIT 1) AS document_id
         FROM feed_items f ORDER BY COALESCE(f.publication_date, f.first_seen_at) DESC, f.id LIMIT ?`
      )
      .all(workspaceId, Math.min(Math.max(limit, 1), 500)) as Row[];
    const notes = this.feedNotes(workspaceId);
    return rows.map((r) => ({ ...this.feedItemFrom(r), watch: notes.get(String(r.id)) ?? null }));
  }

  /** Regulation watch notes of a workspace, by feed item id. */
  feedNotes(workspaceId: string): Map<string, FeedNote> {
    const rows = this.db.prepare('SELECT * FROM feed_item_notes WHERE workspace_id = ?').all(workspaceId) as Row[];
    return new Map(rows.map((r) => [String(r.feed_item_id), this.feedNoteFrom(r)]));
  }

  private feedNoteFrom(r: Row): FeedNote {
    return {
      category: str(r.category),
      affectedRuleKeys: JSON.parse(String(r.affected_rule_keys_json)) as string[],
      summary: str(r.summary),
      model: str(r.model),
      updatedAt: String(r.updated_at),
    };
  }

  /** Stores (or updates) regulation watch's note; a later summary keeps the earlier rule match's row. */
  noteFeedItem(workspaceId: string, feedItemId: string, note: { category: string | null; affectedRuleKeys: string[]; summary?: string; model?: string }): void {
    this.db
      .prepare(
        `INSERT INTO feed_item_notes (workspace_id, feed_item_id, category, affected_rule_keys_json, summary, model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, feed_item_id) DO UPDATE SET category = excluded.category, affected_rule_keys_json = excluded.affected_rule_keys_json,
           summary = COALESCE(excluded.summary, feed_item_notes.summary), model = COALESCE(excluded.model, feed_item_notes.model), updated_at = excluded.updated_at`
      )
      .run(workspaceId, feedItemId, note.category, JSON.stringify(note.affectedRuleKeys), note.summary ?? null, note.model ?? null, nowIso());
  }

  getFeedItem(workspaceId: string, id: string): FeedItem | undefined {
    return this.listFeedItems(workspaceId, 500).find((i) => i.id === id);
  }

  /** Links a document to the feed item it was made from (or, with no item, to the page it was imported from). */
  linkDocumentToFeedItem(workspaceId: string, documentId: string, feedItemId: string | null, sourceUrl: string | null): void {
    this.db.prepare('UPDATE documents SET feed_item_id = ?, source_url = ? WHERE id = ? AND workspace_id = ?').run(feedItemId, sourceUrl, documentId, workspaceId);
  }

  /** Whether a scheduled job is due (never ran, or last ran at least `everyMs` ago); marks it as run when due. */
  claimScheduledRun(name: string, everyMs: number, now: Date = new Date()): boolean {
    const r = this.db.prepare('SELECT last_run_at FROM scheduler_runs WHERE name = ?').get(name) as Row | undefined;
    if (r && now.getTime() - Date.parse(String(r.last_run_at)) < everyMs) return false;
    this.db.prepare('INSERT OR REPLACE INTO scheduler_runs (name, last_run_at) VALUES (?, ?)').run(name, now.toISOString());
    return true;
  }

  // ---------------------------------------------------------------- fix pull requests and suggestions (Phase 4)

  getFixPr(repoId: string, baseSha: string): { prNumber: number; url: string; branch: string; baseSha: string; commitSha: string; files: string[]; addressed: string[] } | undefined {
    const r = this.db.prepare('SELECT * FROM fix_prs WHERE repo_id = ? AND base_sha = ?').get(repoId, baseSha) as Row | undefined;
    return r ? this.fixPrFrom(r) : undefined;
  }

  listFixPrs(repoId: string): Array<{ prNumber: number; url: string; branch: string; baseSha: string; commitSha: string; files: string[]; addressed: string[]; createdAt: string }> {
    return (this.db.prepare('SELECT * FROM fix_prs WHERE repo_id = ? ORDER BY created_at DESC').all(repoId) as Row[]).map((r) => ({ ...this.fixPrFrom(r), createdAt: String(r.created_at) }));
  }

  private fixPrFrom(r: Row) {
    return {
      prNumber: Number(r.pr_number),
      url: String(r.url),
      branch: String(r.branch),
      baseSha: String(r.base_sha),
      commitSha: String(r.commit_sha),
      files: JSON.parse(String(r.files_json)) as string[],
      addressed: JSON.parse(String(r.addressed_json)) as string[],
    };
  }

  recordFixPr(input: { repoId: string; baseSha: string; prNumber: number; url: string; branch: string; commitSha: string; files: string[]; addressed: string[]; requestedBy: string }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO fix_prs (repo_id, base_sha, pr_number, url, branch, commit_sha, files_json, addressed_json, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.repoId, input.baseSha, input.prNumber, input.url, input.branch, input.commitSha, JSON.stringify(input.files), JSON.stringify(input.addressed), input.requestedBy, nowIso());
  }

  suggestedFingerprints(repoId: string, prNumber: number): Set<string> {
    return new Set((this.db.prepare('SELECT fingerprint FROM pr_suggestions WHERE repo_id = ? AND pr_number = ?').all(repoId, prNumber) as Row[]).map((r) => String(r.fingerprint)));
  }

  recordSuggestion(repoId: string, prNumber: number, fingerprint: string): void {
    this.db.prepare('INSERT OR IGNORE INTO pr_suggestions (repo_id, pr_number, fingerprint, created_at) VALUES (?, ?, ?, ?)').run(repoId, prNumber, fingerprint, nowIso());
  }

  // ---------------------------------------------------------------- share links (Phase 5)

  private shareFrom(r: Row): ShareRecord {
    const revokedAt = str(r.revoked_at);
    const expiresAt = String(r.expires_at);
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      label: str(r.label),
      counterpartyId: str(r.counterparty_id),
      counterpartyName: str(r.counterparty_name),
      ruleIds: JSON.parse(String(r.rule_ids_json)) as string[],
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

  private static readonly SHARE_SELECT = `SELECT s.*, c.name AS counterparty_name, u.name AS created_by_name,
      (SELECT COUNT(*) FROM share_views v WHERE v.share_id = s.id) AS views,
      (SELECT MAX(v.at) FROM share_views v WHERE v.share_id = s.id) AS last_viewed_at
    FROM shares s LEFT JOIN counterparties c ON c.id = s.counterparty_id LEFT JOIN users u ON u.id = s.created_by`;

  /** Rules a share covers when none are picked: every rule with an approved or retired version. */
  currentRuleIds(workspaceId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT r.id FROM rules r WHERE r.workspace_id = ? AND EXISTS (SELECT 1 FROM rule_versions v WHERE v.rule_id = r.id AND v.status IN ('approved', 'retired'))
           ORDER BY r.created_at`
        )
        .all(workspaceId) as Row[]
    ).map((r) => String(r.id));
  }

  /**
   * Creates a share of some rules over a period, optionally for one counterparty (whose scope
   * picks the repositories). Returns the token once; only its SHA-256 is stored.
   */
  createShare(
    input: { workspaceId: string; label?: string | null; counterpartyId?: string | null; ruleIds: string[]; periodFrom: string; periodTo: string; expiresAt: string; createdBy: string },
    now: Date = new Date()
  ): { token: string; share: ShareRecord } {
    const ruleIds = [...new Set(input.ruleIds)];
    if (ruleIds.length === 0) throw new StoreError('a share needs at least one rule');
    for (const id of ruleIds) if (!this.db.prepare('SELECT 1 FROM rules WHERE id = ? AND workspace_id = ?').get(id, input.workspaceId)) throw new StoreError(`unknown rule ${id}`, 404);
    if (input.counterpartyId && !this.db.prepare('SELECT 1 FROM counterparties WHERE id = ? AND workspace_id = ?').get(input.counterpartyId, input.workspaceId)) throw new StoreError('unknown counterparty', 404);
    const from = new Date(input.periodFrom);
    const to = new Date(input.periodTo);
    const expires = new Date(input.expiresAt);
    if ([from, to, expires].some((d) => Number.isNaN(d.getTime()))) throw new StoreError('periodFrom, periodTo and expiresAt must be dates');
    if (to.getTime() < from.getTime()) throw new StoreError('the period ends before it starts');
    if (expires.getTime() <= now.getTime()) throw new StoreError('expiresAt must be in the future');
    if (expires.getTime() > now.getTime() + 366 * 24 * 3600 * 1000) throw new StoreError('a share link can last at most one year');
    const token = SHARE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const id = newId();
    this.db
      .prepare('INSERT INTO shares (id, workspace_id, token_sha256, label, counterparty_id, rule_ids_json, period_from, period_to, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.workspaceId, sha256Hex(token), input.label?.trim().slice(0, 200) || null, input.counterpartyId || null, JSON.stringify(ruleIds), from.toISOString(), to.toISOString(), input.createdBy, now.toISOString(), expires.toISOString());
    return { token, share: this.getShare(input.workspaceId, id)! };
  }

  getShare(workspaceId: string, id: string): ShareRecord | undefined {
    const r = this.db.prepare(`${ProductStore.SHARE_SELECT} WHERE s.id = ? AND s.workspace_id = ?`).get(id, workspaceId) as Row | undefined;
    return r ? this.shareFrom(r) : undefined;
  }

  listShares(workspaceId: string): ShareRecord[] {
    return (this.db.prepare(`${ProductStore.SHARE_SELECT} WHERE s.workspace_id = ? ORDER BY s.created_at DESC`).all(workspaceId) as Row[]).map((r) => this.shareFrom(r));
  }

  /** The share a token opens, or null when it is unknown, revoked or expired. */
  shareByToken(token: string, at: Date = new Date()): ShareRecord | null {
    if (!token.startsWith(SHARE_TOKEN_PREFIX)) return null;
    const r = this.db.prepare(`${ProductStore.SHARE_SELECT} WHERE s.token_sha256 = ?`).get(sha256Hex(token)) as Row | undefined;
    if (!r || r.revoked_at || String(r.expires_at) <= at.toISOString()) return null;
    return this.shareFrom(r);
  }

  revokeShare(workspaceId: string, id: string): ShareRecord {
    const share = this.getShare(workspaceId, id);
    if (!share) throw new StoreError('unknown share', 404);
    if (share.revokedAt) return share;
    this.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(nowIso(), id);
    return this.getShare(workspaceId, id)!;
  }

  recordShareView(shareId: string, ip: string | null, userAgent: string | null): void {
    this.db.prepare('INSERT INTO share_views (share_id, at, ip, user_agent) VALUES (?, ?, ?, ?)').run(shareId, nowIso(), ip?.slice(0, 100) ?? null, userAgent?.slice(0, 500) ?? null);
  }

  listShareViews(shareId: string): Array<{ at: string; ip: string | null; userAgent: string | null }> {
    return (this.db.prepare('SELECT at, ip, user_agent FROM share_views WHERE share_id = ? ORDER BY at DESC').all(shareId) as Row[]).map((r) => ({ at: String(r.at), ip: str(r.ip), userAgent: str(r.user_agent) }));
  }

  /** Repositories a counterparty's scope covers (every repository when there is no counterparty). */
  reposForCounterparty(workspaceId: string, counterpartyId: string | null): Repo[] {
    const repos = this.listRepos(workspaceId);
    if (!counterpartyId) return repos;
    const ids = new Set((this.db.prepare('SELECT DISTINCT repo_id FROM counterparty_scope WHERE counterparty_id = ?').all(counterpartyId) as Row[]).map((r) => String(r.repo_id)));
    return repos.filter((r) => ids.has(r.id));
  }

  // ---------------------------------------------------------------- API tokens and MCP calls (Phase 4a)
  private tokenFrom(r: Row): ApiTokenRecord {
    const revokedAt = str(r.revoked_at);
    const expiresAt = String(r.expires_at);
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      userId: String(r.user_id),
      userName: str(r.user_name),
      name: String(r.name),
      hint: str(r.token_hint),
      createdAt: String(r.created_at),
      expiresAt,
      lastUsedAt: str(r.last_used_at),
      lastClient: str(r.last_client),
      revokedAt,
      status: revokedAt ? 'revoked' : expiresAt <= nowIso() ? 'expired' : 'active',
    };
  }

  private static readonly TOKEN_SELECT = 'SELECT t.*, u.name AS user_name FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id';

  private insertApiToken(workspaceId: string, userId: string, name: string, ttlMs: number): { token: string; record: ApiTokenRecord } {
    const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const id = newId();
    const now = new Date();
    this.db
      .prepare('INSERT INTO api_tokens (id, workspace_id, user_id, name, token_sha256, token_hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, workspaceId, userId, name, sha256Hex(token), token.slice(-4), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
    return { token, record: this.getApiToken(workspaceId, id)! };
  }

  /**
   * Creates a personal access token for a member of the workspace. The token is returned once;
   * only its SHA-256 and its last four characters are stored.
   */
  createApiToken(workspaceId: string, userId: string, name: string, days: number = API_TOKEN_DEFAULT_DAYS): { token: string; record: ApiTokenRecord } {
    if (!this.roleOf(workspaceId, userId)) throw new StoreError('workspace not found', 404);
    const label = name.trim().slice(0, 100);
    if (!label) throw new StoreError('a token needs a name');
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new StoreError('a token lasts between 1 and 366 days');
    return this.insertApiToken(workspaceId, userId, label, days * 24 * 3600 * 1000);
  }

  /** A token that lasts `ttlMs` (OAuth access tokens: one hour). */
  createShortLivedApiToken(workspaceId: string, userId: string, name: string, ttlMs: number): { token: string; record: ApiTokenRecord } {
    if (!this.roleOf(workspaceId, userId)) throw new StoreError('workspace not found', 404);
    return this.insertApiToken(workspaceId, userId, name.slice(0, 100), ttlMs);
  }

  getApiToken(workspaceId: string, tokenId: string): ApiTokenRecord | undefined {
    const r = this.db.prepare(`${ProductStore.TOKEN_SELECT} WHERE t.id = ? AND t.workspace_id = ?`).get(tokenId, workspaceId) as Row | undefined;
    return r ? this.tokenFrom(r) : undefined;
  }

  /** Revokes a token by id, whoever owns it (OAuth rotation and code reuse). */
  revokeApiTokenById(tokenId: string): void {
    this.db.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(nowIso(), tokenId);
  }

  /** A user's tokens in a workspace, newest first. */
  listApiTokens(workspaceId: string, userId: string): ApiTokenRecord[] {
    return (this.db.prepare(`${ProductStore.TOKEN_SELECT} WHERE t.workspace_id = ? AND t.user_id = ? ORDER BY t.created_at DESC`).all(workspaceId, userId) as Row[]).map((r) =>
      this.tokenFrom(r)
    );
  }

  /** Every token in a workspace, newest first (for owners). */
  listAllApiTokens(workspaceId: string): ApiTokenRecord[] {
    return (this.db.prepare(`${ProductStore.TOKEN_SELECT} WHERE t.workspace_id = ? ORDER BY t.created_at DESC`).all(workspaceId) as Row[]).map((r) => this.tokenFrom(r));
  }

  /**
   * Revokes one of the user's own tokens, or, with `canRevokeOthers` (workspace owners), any
   * token in the workspace. Someone else's token is "unknown" to a user who may not revoke it.
   */
  revokeApiToken(workspaceId: string, userId: string, tokenId: string, options: { canRevokeOthers?: boolean } = {}): ApiTokenRecord {
    const t = this.getApiToken(workspaceId, tokenId);
    if (!t || (t.userId !== userId && !options.canRevokeOthers)) throw new StoreError('unknown token', 404);
    if (!t.revokedAt) this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), tokenId);
    return this.getApiToken(workspaceId, tokenId)!;
  }

  /** Remembers the MCP client (clientInfo.name) a token last connected with. */
  setApiTokenClient(tokenId: string, client: string): void {
    this.db.prepare('UPDATE api_tokens SET last_client = ? WHERE id = ?').run(client.slice(0, 80), tokenId);
  }

  /**
   * The user and workspace a token acts for, or null when it is unknown, revoked, expired, its
   * workspace is archived, or its user is no longer a member. Records the use.
   */
  tokenPrincipal(token: string, at: Date = new Date()): TokenPrincipal | null {
    if (!token.startsWith(API_TOKEN_PREFIX) || token.length > 200) return null;
    const r = this.db
      .prepare(
        `SELECT t.*, u.oidc_sub FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.token_sha256 = ? AND w.archived_at IS NULL`
      )
      .get(sha256Hex(token)) as Row | undefined;
    if (!r || r.revoked_at || String(r.expires_at) <= at.toISOString()) return null;
    const role = this.roleOf(String(r.workspace_id), String(r.user_id));
    if (!role) return null;
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(at.toISOString(), String(r.id));
    return { tokenId: String(r.id), workspaceId: String(r.workspace_id), userId: String(r.user_id), userSub: String(r.oidc_sub), role };
  }

  /** Logs one MCP request. Without a userId the token's owner is recorded. */
  recordMcpCall(input: McpCallInput): void {
    this.db
      .prepare(
        `INSERT INTO mcp_calls (id, workspace_id, token_id, user_id, client, method, tool, repo, outcome, summary, duration_ms, detail_json, created_at)
         VALUES (?, ?, ?, COALESCE(?, (SELECT user_id FROM api_tokens WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId(),
        input.workspaceId,
        input.tokenId,
        input.userId ?? null,
        input.tokenId,
        input.client?.slice(0, 80) ?? null,
        input.method.slice(0, 100),
        input.tool?.slice(0, 100) ?? null,
        input.repo?.slice(0, 300) ?? null,
        input.outcome,
        input.summary?.slice(0, 500) ?? null,
        Math.round(input.durationMs),
        input.detail ? JSON.stringify(input.detail).slice(0, 20000) : null,
        nowIso()
      );
  }

  /** The newest MCP calls of a workspace; `toolCallsOnly` leaves out handshakes and listings. */
  listMcpCalls(workspaceId: string, limit = 50, options: { toolCallsOnly?: boolean } = {}): McpCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, u.name AS user_name FROM mcp_calls c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.workspace_id = ?${options.toolCallsOnly ? ' AND c.tool IS NOT NULL' : ''} ORDER BY c.created_at DESC LIMIT ?`
      )
      .all(workspaceId, Math.min(Math.max(limit, 1), 500)) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      tokenId: str(r.token_id),
      userId: str(r.user_id),
      userName: str(r.user_name),
      client: str(r.client),
      method: String(r.method),
      tool: str(r.tool),
      repo: str(r.repo),
      outcome: r.outcome as McpCallOutcome,
      summary: str(r.summary),
      durationMs: Number(r.duration_ms),
      detail: r.detail_json ? (JSON.parse(String(r.detail_json)) as Record<string, unknown>) : null,
      createdAt: String(r.created_at),
    }));
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

  /** Repositories a rule applies to: all of the workspace's, or those in its counterparties' scope. */
  reposInScope(workspaceId: string, scope: RuleScope): Repo[] {
    const repos = this.listRepos(workspaceId);
    if (scope.all || !scope.counterpartyIds?.length) return repos;
    return repos.filter((r) => this.ruleScopeGlobs(scope, r.id).length > 0);
  }

  /** The latest completed scan of a repository's default branch (not a pull request), with its facts. */
  latestBranchScan(repoId: string): (BranchScanRecord & { facts: { sqlTables: unknown[]; astFindings: unknown[] } }) | null {
    const r = this.db
      .prepare(
        "SELECT id, repo_id, commit_sha, finished_at, conclusion, facts_json FROM scans WHERE repo_id = ? AND status = 'completed' AND pr_number IS NULL AND facts_json IS NOT NULL ORDER BY finished_at DESC LIMIT 1"
      )
      .get(repoId) as Row | undefined;
    if (!r) return null;
    const facts = JSON.parse(String(r.facts_json)) as { sqlTables?: unknown[]; astFindings?: unknown[] };
    return { ...this.branchScanFrom(r), facts: { sqlTables: facts.sqlTables ?? [], astFindings: facts.astFindings ?? [] } };
  }

  /**
   * The latest completed scan of a repository's default branch that was a real check (not the
   * baseline of a pull request's base commit), whether or not it kept facts.
   */
  latestCheckedBranchScan(repoId: string): (BranchScanRecord & { facts: { sqlTables: unknown[]; astFindings: unknown[] } | null }) | null {
    const r = this.db
      .prepare(
        "SELECT id, repo_id, commit_sha, finished_at, conclusion, facts_json FROM scans WHERE repo_id = ? AND pr_number IS NULL AND trigger <> 'baseline' AND status = 'completed' ORDER BY finished_at DESC LIMIT 1"
      )
      .get(repoId) as Row | undefined;
    if (!r) return null;
    return { ...this.branchScanFrom(r), facts: r.facts_json ? (JSON.parse(String(r.facts_json)) as { sqlTables: unknown[]; astFindings: unknown[] }) : null };
  }

  private branchScanFrom(r: Row): BranchScanRecord {
    return { id: String(r.id), repoId: String(r.repo_id), commitSha: String(r.commit_sha), finishedAt: str(r.finished_at), conclusion: str(r.conclusion) };
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
