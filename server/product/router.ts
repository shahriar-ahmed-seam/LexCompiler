import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readRepositoryFilesAt } from '../analyzer/repoBaseline.js';
import { AiGateway, localModelConfig, modelForTask } from '../ai/gateway.js';
import { OidcProvider, type Principal, type SessionStore } from '../auth/oidc.js';
import { tokensMatch, type Authenticator } from '../security.js';
import { describeEvidence } from '../evidence/describe.js';
import type { EvidenceLog, PublicKeyEntry } from '../evidence/log.js';
import type { EvidenceRecorder } from '../evidence/records.js';
import type { TargetRepoFile } from '../../shared/types.js';
import type { CrewRun, CrewRunStore } from '../agents/crew.js';
import { checkWebhookUrl, EVENT_TYPES, sendTestEvent } from '../events/outbound.js';
import { watchRegulationFeed } from './regulationWatch.js';
import { fetchActText, fetchUrlText, type ActTextDeps } from '../regulations/actText.js';
import { scanLocalRepo, storeComingUp } from './repoScan.js';
import type { RuleCategory } from '../../shared/types.js';
import { compileClause, isRuleCategory, libraryTemplates, RULE_CATEGORIES, validateClauseValues } from './clauses.js';
import { DocumentError, extractDocumentText, looksLikeLegacyBangla, MAX_DOCUMENT_BYTES, splitClauses } from './documents.js';
import { decideException, expireExceptions, requestExceptions, ruleDecided, type FlowDeps } from './flows.js';
import { buildRuleCard, CATEGORY_LABELS, cleanOverrides, impactPreview, type RuleCard } from './ruleCard.js';
import { can, ProductStore, StoreError, WORKSPACE_ROLES, type ExceptionRecord, type ExceptionStatus, type Permission, type Repo, type RuleScope, type RuleVersion, type StoredFinding, type User, type WorkspaceRole } from './store.js';

/** Bearer API token (admin), OIDC bearer JWT, or a session cookie (OIDC or password sign-in). */
export function createAuthenticator(oidc: OidcProvider | null, apiToken: string | null, sessions?: SessionStore): Authenticator {
  return async (req) => {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (bearer && apiToken && tokensMatch(apiToken, bearer)) return { sub: 'api-token', globalRole: 'admin', via: 'api-token' };
    if (bearer) return oidc ? oidc.principalFromBearer(bearer) : null;
    const sid = OidcProvider.sessionIdFromCookies(req.headers.cookie);
    if (oidc) return oidc.principalFromSession(sid);
    return sid && sessions ? sessions.get(sid) : null;
  };
}

const principalOf = (res: Response) => res.locals.principal as Principal;
const wid = (req: Request) => String(req.params.workspaceId);

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
/** Runs a handler and turns StoreError (and anything else) into a JSON error response. */
const handle = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err instanceof StoreError ? err.status : 500;
    if (!res.headersSent) res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
};

/** Helpers the workspace routes share, handed to `extra`. */
export interface RouteHelpers {
  userOf: (res: Response) => User;
  roleIn: (req: Request, res: Response) => WorkspaceRole | 'admin' | null;
  need: (permission: Permission) => (req: Request, res: Response, next: NextFunction) => void;
  isAdmin: (res: Response) => boolean;
  handle: (fn: Handler) => (req: Request, res: Response) => Promise<void>;
  wid: (req: Request) => string;
  /** The exception and rule lifecycle (requests, decisions, revokes, expiry, re-checks, evidence). */
  flows: FlowDeps;
  /** The signed evidence log, when the server records one. */
  evidence: EvidenceLog | null;
  /** Every public key that signed a workspace's records (for verification). */
  keysFor: (workspaceId: string) => Promise<PublicKeyEntry[]>;
  /** Sign-in is by OIDC (the router then owns /auth/logout). */
  oidcEnabled: boolean;
}

export interface ProductRouterOptions {
  /** Local repositories must live inside this directory. */
  reposRoot: string;
  /** Model calls; defaults to a gateway on the store's database. */
  ai?: AiGateway;
  /**
   * Queues a scan of a repository's default branch after a rule is approved, and returns the job
   * id (null when an identical scan is already queued). Without it, approval queues nothing.
   */
  enqueueBranchScan?: (repo: Repo, version: RuleVersion) => string | null;
  /**
   * The exception and rule lifecycle (flows.ts): requests, decisions, revokes, expiry, the
   * re-check jobs and the comments on pull requests. Without it, nothing is queued and the
   * evidence goes to `evidence` (tests).
   */
  flows?: FlowDeps;
  /** Overrides the re-check an exception decision queues (tests); it returns the job id. */
  onExceptionDecided?: (exception: ExceptionRecord) => string | null;
  /** The workspace MCP endpoint, shown on the settings page (default `<publicUrl>/mcp`). */
  mcpUrl?: string;
  /** Writes the signed evidence log (Phase 5). Without it, nothing is recorded. */
  evidence?: EvidenceRecorder;
  /** Every public key that signed a workspace's records; defaults to the log's current keys. */
  keysFor?: (workspaceId: string) => Promise<PublicKeyEntry[]>;
  /** Where share links point (default http://localhost:3001). */
  publicUrl?: string;
  /** Reads a GitHub repository's files at a commit, to refresh "Coming up" on demand. */
  readRepoFiles?: (repo: Repo, commitSha: string) => Promise<TargetRepoFile[]>;
  /** Fetches the regulation feed and stores new items; returns how many were new. */
  refreshFeed?: () => Promise<number>;
  /** Fetch and Browserbase key for "Fetch the act's text" and "Import from URL" (tests inject fetch). */
  actText?: ActTextDeps;
  /** Opens a verified fix pull request for a GitHub repository's default branch (Phase 4). */
  openFixPr?: (repo: Repo, requestedBy: string) => Promise<{ created: boolean }>;
  /** The agent crew on a workspace repository (server/agents/workspaceCrew.ts). */
  crew?: {
    run: (repo: Repo, opts: { useModels: boolean; openPullRequest: boolean; requestedBy: string; triggeredBy: string | null; allRules?: boolean }) => Promise<CrewRun>;
    runs: CrewRunStore;
  };
  /** Mounts more workspace routes with the same access checks (workspaceRoutes.ts). */
  extra?: (r: express.Router, helpers: RouteHelpers) => void;
  /** Email and password sign-in is on (reported by /auth/config). */
  passwordSignIn?: boolean;
}

const EXCEPTION_STATUSES: ExceptionStatus[] = ['requested', 'approved', 'rejected', 'expired', 'revoked'];

/** The card as stored with a draft: everything except the compiled clause, which the version has. */
function storedCard(card: RuleCard): Record<string, unknown> {
  const { clause: _clause, ...rest } = card;
  void _clause;
  return rest as unknown as Record<string, unknown>;
}

/** A rule scope from a request: all of the workspace's repos, or the named counterparties'. */
function scopeFrom(store: ProductStore, workspaceId: string, raw: unknown): RuleScope {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = Array.isArray(o.counterpartyIds) ? o.counterpartyIds.map(String) : [];
  if (o.all === true || ids.length === 0) return { all: true };
  const known = new Set(store.listCounterparties(workspaceId).map((c) => c.id));
  for (const id of ids) if (!known.has(id)) throw new StoreError(`unknown counterparty ${id}`, 404);
  return { counterpartyIds: [...new Set(ids)] };
}

/** Sign-in endpoints and the workspace API (members, repositories, rules, scans). */
export function createProductRouter(store: ProductStore, oidc: OidcProvider | null, options: ProductRouterOptions) {
  const r = express.Router();
  const reposRoot = path.resolve(options.reposRoot);
  const ai = options.ai ?? new AiGateway(store.db);
  const publicUrl = (options.publicUrl ?? 'http://localhost:3001').replace(/\/+$/, '');
  const testInFlight = new Set<string>();
  const testSentAt = new Map<string, number>();
  const flows: FlowDeps = options.flows ?? { store, evidence: options.evidence, queue: null, publicUrl };
  const keysFor =
    options.keysFor ?? ((workspaceId: string) => (options.evidence ? options.evidence.log.publicKeys(workspaceId, [], new Map()) : Promise.resolve([] as PublicKeyEntry[])));

  /** The signed-in person as a user row, created on first use. */
  const userOf = (res: Response): User => {
    const who = principalOf(res);
    const known = store.getUserBySub(who.sub);
    // Refresh the profile when the identity provider reports a newer email or verification.
    if (known && (who.via === 'oidc-session' || who.via === 'oidc-bearer') && (known.email !== (who.email ?? known.email) || known.emailVerified !== Boolean(who.emailVerified))) {
      return store.upsertUser({ sub: who.sub, email: who.email, emailVerified: Boolean(who.emailVerified), name: who.name });
    }
    return known ?? store.upsertUser({ sub: who.sub, email: who.email, emailVerified: Boolean(who.emailVerified), name: who.name });
  };
  const isAdmin = (res: Response) => principalOf(res)?.globalRole === 'admin';
  /** The caller's role in the workspace; global admins act with every permission. */
  const roleIn = (req: Request, res: Response): WorkspaceRole | 'admin' | null =>
    isAdmin(res) ? 'admin' : store.roleOf(wid(req), userOf(res).id);
  const need = (permission: Permission) => (req: Request, res: Response, next: NextFunction) => {
    if (!store.getWorkspace(wid(req))) return void res.status(404).json({ error: 'workspace not found' });
    const role = roleIn(req, res);
    if (role === 'admin' || can(role, permission)) return next();
    // Non-members get 404, so workspace ids can't be probed.
    if (!role) return void res.status(404).json({ error: 'workspace not found' });
    res.status(403).json({ error: `your role (${role}) does not allow this (${permission})` });
  };

  // ---------------------------------------------------------------- sign-in

  r.get('/auth/config', (_req, res) => {
    res.json({ oidcEnabled: Boolean(oidc), passwordSignIn: Boolean(options.passwordSignIn), issuer: oidc?.config.issuer ?? null, loginUrl: oidc ? '/api/auth/login' : null });
  });
  if (oidc) {
    r.get('/auth/login', async (req, res) => {
      try {
        res.redirect(302, await oidc.beginLogin(String(req.query.returnTo || '/')));
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    });
    r.get('/auth/callback', async (req, res) => {
      try {
        const { sessionId, principal, returnTo } = await oidc.completeLogin({ code: req.query.code as string, state: req.query.state as string, error: req.query.error as string });
        const user = store.upsertUser({ sub: principal.sub, email: principal.email, emailVerified: Boolean(principal.emailVerified), name: principal.name });
        store.acceptInvitations(user);
        res.setHeader('Set-Cookie', oidc.sessionCookie(sessionId));
        res.redirect(302, returnTo);
      } catch (err) {
        res.status(401).json({ error: `Sign-in failed: ${(err as Error).message}` });
      }
    });
    r.post('/auth/logout', (req, res) => {
      oidc.endSession(OidcProvider.sessionIdFromCookies(req.headers.cookie));
      res.setHeader('Set-Cookie', oidc.clearedCookie());
      res.json({ signedOut: true });
    });
  }
  r.get('/auth/me', (_req, res) => {
    const who = principalOf(res);
    if (!who) return void res.json(null);
    const user = userOf(res);
    store.acceptInvitations(user);
    const workspaces = isAdmin(res) ? store.listWorkspaces().map((w) => ({ ...w, role: 'admin' as const })) : store.listWorkspacesForUser(user.id);
    res.json({ ...who, userId: user.id, workspaces });
  });

  // ---------------------------------------------------------------- workspaces and members

  r.get('/workspaces', (_req, res) => {
    const user = userOf(res);
    res.json(isAdmin(res) ? store.listWorkspaces().map((w) => ({ ...w, role: 'admin' })) : store.listWorkspacesForUser(user.id));
  });
  r.post(
    '/workspaces',
    handle((req, res) => {
      const ws = store.createWorkspace(String(req.body?.name || ''), userOf(res).id);
      res.status(201).json({ ...ws, role: 'owner' });
    })
  );
  r.get('/workspaces/:workspaceId', need('view'), (req, res) => res.json({ ...store.getWorkspace(wid(req)), role: roleIn(req, res) }));

  r.get('/workspaces/:workspaceId/members', need('view'), (req, res) => {
    const members = store.listMembers(wid(req));
    const role = roleIn(req, res);
    res.json({ members, invitations: role === 'owner' || role === 'admin' ? store.listInvitations(wid(req)) : [] });
  });
  r.post(
    '/workspaces/:workspaceId/members',
    need('manageWorkspace'),
    handle((req, res) => {
      const role = String(req.body?.role) as WorkspaceRole;
      if (!WORKSPACE_ROLES.includes(role)) throw new StoreError(`role must be one of ${WORKSPACE_ROLES.join(', ')}`);
      res.status(201).json(store.invite(wid(req), String(req.body?.email || ''), role, userOf(res).id));
    })
  );
  r.put(
    '/workspaces/:workspaceId/members/:userId',
    need('manageWorkspace'),
    handle((req, res) => {
      const role = String(req.body?.role) as WorkspaceRole;
      if (!store.listMembers(wid(req)).some((m) => m.userId === req.params.userId)) throw new StoreError('not a member', 404);
      store.setMemberRole(wid(req), String(req.params.userId), role);
      res.json({ userId: req.params.userId, role });
    })
  );
  r.delete(
    '/workspaces/:workspaceId/members/:userId',
    need('manageWorkspace'),
    handle((req, res) => {
      store.removeMember(wid(req), String(req.params.userId));
      res.json({ removed: req.params.userId });
    })
  );

  // ---------------------------------------------------------------- AI setting (off by default)

  const aiStatus = (workspaceId: string) => {
    const settings = ai.settings(workspaceId);
    const cloud = modelForTask('drafting', 'cloud');
    return {
      ...settings,
      // The server can cap every workspace (LEXCOMPILER_AI_MAX_DAILY_TOKENS).
      dailyTokenBudget: ai.effectiveBudget(workspaceId),
      tokensUsedToday: ai.tokensUsedToday(workspaceId),
      // The models each mode would use, so the owner sees where contract text goes.
      models: { local: localModelConfig().label, cloud: cloud ? cloud.label : null },
    };
  };
  r.get('/workspaces/:workspaceId/ai', need('view'), (req, res) => res.json(aiStatus(wid(req))));
  r.put(
    '/workspaces/:workspaceId/ai',
    need('manageWorkspace'),
    handle((req, res) => {
      try {
        ai.setSettings(wid(req), { mode: req.body?.mode, dailyTokenBudget: req.body?.dailyTokenBudget }, userOf(res).id);
      } catch (err) {
        throw new StoreError((err as Error).message);
      }
      res.json(aiStatus(wid(req)));
    })
  );
  r.get('/workspaces/:workspaceId/ai/calls', need('view'), (req, res) => res.json(ai.listCalls(wid(req), Number(req.query.limit) || 50)));

  // ---------------------------------------------------------------- repositories and counterparties

  r.get('/workspaces/:workspaceId/repos', need('view'), (req, res) => res.json(store.listRepos(wid(req))));
  r.post(
    '/workspaces/:workspaceId/repos',
    need('manageWorkspace'),
    handle((req, res) => {
      // A folder path is not tied to a workspace, so an owner could point at another workspace's
      // checkout. Only administrators register folders; customers connect repos through GitHub.
      if (!isAdmin(res)) throw new StoreError('only administrators can register local repositories; connect GitHub repositories through the GitHub App', 403);
      const rel = String(req.body?.localPath || '');
      const abs = path.resolve(reposRoot, rel);
      const relative = path.relative(reposRoot, abs);
      if (!rel || relative.startsWith('..') || path.isAbsolute(relative)) throw new StoreError(`localPath must be inside ${reposRoot}`);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new StoreError(`repository ${rel} does not exist`);
      res.status(201).json(store.addLocalRepo(wid(req), String(req.body?.name || rel), abs));
    })
  );

  r.get('/workspaces/:workspaceId/github', need('view'), (req, res) => res.json(store.listInstallationsForWorkspace(wid(req))));

  r.get('/workspaces/:workspaceId/counterparties', need('view'), (req, res) => res.json(store.listCounterparties(wid(req))));
  r.post(
    '/workspaces/:workspaceId/counterparties',
    need('createShares'),
    handle((req, res) => res.status(201).json(store.createCounterparty(wid(req), String(req.body?.name || ''))))
  );
  /**
   * The repositories and path globs that handle a counterparty's data: { scope: [{ repoId, pathGlob }] }.
   * Rules scoped to the counterparty are proven only on these paths.
   */
  r.post(
    '/workspaces/:workspaceId/counterparties/:counterpartyId/scope',
    need('editRules'),
    handle((req, res) => {
      const raw = Array.isArray(req.body?.scope) ? (req.body.scope as Array<Record<string, unknown>>) : null;
      if (!raw) throw new StoreError('scope must be a list of { repoId, pathGlob }');
      const repos = new Set(store.listRepos(wid(req)).map((r) => r.id));
      const scope = raw.map((s) => {
        const repoId = String(s.repoId ?? '');
        const pathGlob = String(s.pathGlob ?? '').trim().replace(/^\/+/, '') || '**';
        if (!repos.has(repoId)) throw new StoreError(`unknown repository ${repoId}`, 404);
        if (pathGlob.includes('..')) throw new StoreError(`"${pathGlob}" is not a path glob inside the repository`);
        return { repoId, pathGlob };
      });
      store.setCounterpartyScope(wid(req), String(req.params.counterpartyId), scope);
      const cp = store.listCounterparties(wid(req)).find((c) => c.id === String(req.params.counterpartyId));
      if (!cp) throw new StoreError('unknown counterparty', 404);
      res.json(cp);
    })
  );

  // ---------------------------------------------------------------- rules

  // ---------------------------------------------------------------- documents (Phase 3)

  r.get('/workspaces/:workspaceId/documents', need('view'), (req, res) => res.json(store.listDocuments(wid(req))));
  /**
   * Uploads a contract, regulation or policy: { title, kind, counterpartyId?, language?, and either
   * text, or fileName with contentBase64 (PDF, DOCX or UTF-8 text, up to 3 MB) }.
   */
  r.post(
    '/workspaces/:workspaceId/documents',
    need('editRules'),
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = String(body.kind || 'contract');
      if (!['contract', 'regulation', 'policy'].includes(kind)) throw new StoreError('kind must be contract, regulation or policy');
      const language = body.language ? String(body.language).slice(0, 10) : null;
      let text: string;
      let file: { name: string; format: string; data: Buffer; sha256: string } | undefined;
      if (typeof body.contentBase64 === 'string' && body.contentBase64) {
        const data = Buffer.from(body.contentBase64, 'base64');
        if (data.length > MAX_DOCUMENT_BYTES) throw new StoreError(`the file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`, 413);
        const name = String(body.fileName || 'document');
        try {
          const extracted = await extractDocumentText(data, name);
          text = extracted.text;
          file = { name, format: extracted.format, data, sha256: extracted.fileSha256 };
        } catch (err) {
          if (err instanceof DocumentError) throw new StoreError(err.message, 422);
          throw err;
        }
      } else {
        text = String(body.text || '').replace(/\r\n?/g, '\n');
      }
      if (!text.trim()) throw new StoreError('the document has no text');
      if (text.length > 500_000) throw new StoreError('the document text is too long (max 500,000 characters)', 413);
      if (language === 'bn' && looksLikeLegacyBangla(text)) {
        throw new StoreError('This Bangla document looks like it uses the old Bijoy encoding: its text came out as Latin letters. Upload a Unicode version, or paste the text.', 422);
      }
      const doc = store.addDocument({
        workspaceId: wid(req),
        counterpartyId: body.counterpartyId ? String(body.counterpartyId) : null,
        kind: kind as 'contract' | 'regulation' | 'policy',
        title: String(body.title || file?.name || 'Untitled document'),
        language,
        text,
        uploadedBy: userOf(res).id,
        file,
      });
      const clauses = splitClauses(text);
      res.status(201).json({ ...store.getDocument(wid(req), doc.id), clauses });
    })
  );
  r.get(
    '/workspaces/:workspaceId/documents/:documentId',
    need('view'),
    handle((req, res) => {
      const doc = store.getDocument(wid(req), String(req.params.documentId));
      if (!doc) throw new StoreError('document not found', 404);
      res.json({ ...doc, clauses: splitClauses(doc.text) });
    })
  );
  r.get(
    '/workspaces/:workspaceId/documents/:documentId/file',
    need('view'),
    handle((req, res) => {
      const file = store.getDocumentFile(wid(req), String(req.params.documentId));
      if (!file) throw new StoreError('this document was pasted as text; there is no file', 404);
      const type = file.format === 'pdf' ? 'application/pdf' : file.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain; charset=utf-8';
      res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${file.name.replace(/[^\w.-]+/g, '_')}"`, 'X-Content-Type-Options': 'nosniff' }).send(file.data);
    })
  );

  // ---------------------------------------------------------------- rule cards (Phase 3)

  const repoName = (repo: Repo) => repo.fullName || repo.localPath || repo.id;
  /** The card for a clause, and how many places in each in-scope repo would fail. */
  const cardWithImpact = async (req: Request, text: string, key: string) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const category = body.category;
    if (category !== undefined && category !== null && !isRuleCategory(category)) throw new StoreError(`category must be one of ${RULE_CATEGORIES.join(', ')}`);
    const scope = scopeFrom(store, wid(req), body.scope);
    const card = await buildRuleCard({
      text,
      key,
      title: body.title ? String(body.title) : undefined,
      citation: body.citation ? String(body.citation) : undefined,
      category: (category ?? undefined) as RuleCategory | undefined,
      overrides: cleanOverrides(body.values),
      normativeMatches: Array.isArray(body.normativeMatches) ? (body.normativeMatches as Array<{ start: number; end: number; text: string }>) : undefined,
      ai: body.useAi === false ? undefined : { gateway: ai, workspaceId: wid(req) },
    });
    const impact = await impactPreview(
      card.clause,
      store.reposInScope(wid(req), scope).map((repo) => ({ repoId: repo.id, repoName: repoName(repo), scan: store.latestBranchScan(repo.id) }))
    );
    return { card, impact, scope };
  };
  r.get('/rule-categories', (_req, res) => res.json(RULE_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] }))));
  /** A card preview for clause text; nothing is saved. Body: { text, category?, values?, scope?, citation?, useAi? }. */
  r.post(
    '/workspaces/:workspaceId/rule-card',
    need('editRules'),
    handle(async (req, res) => {
      const text = String(req.body?.text || '').trim();
      if (!text) throw new StoreError('text is required');
      if (text.length > 20000) throw new StoreError('text is too long (max 20000 characters)');
      const { card, impact } = await cardWithImpact(req, text, String(req.body?.ruleKey || store.nextRuleKey(wid(req))));
      const { clause, ...rest } = card;
      res.json({
        ...rest,
        compiled: { smtLib2: clause.compiled.smtLib2Snippet, rego: clause.compiled.opaRegoRule, deonticFormula: clause.compiled.deonticFormula },
        impact,
      });
    })
  );

  r.get('/library/templates', (_req, res) => res.json(libraryTemplates()));
  r.get('/workspaces/:workspaceId/rules', need('view'), (req, res) => res.json(store.listRules(wid(req))));
  /**
   * A draft from clause text: a new rule, or a new version of `ruleId`. Body fields (title,
   * citation, category, values, scope, documentId) come from the request.
   */
  const draftFromText = async (req: Request, res: Response, text: string, documentIdOverride?: string) => {
      if (!text) throw new StoreError('rawLegalText is required');
      if (text.length > 20000) throw new StoreError('rawLegalText is too long (max 20000 characters)');
      const ruleId = req.body?.ruleId ? String(req.body.ruleId) : undefined;
      const existing = ruleId ? store.getRule(wid(req), ruleId) : undefined;
      if (ruleId && !existing) throw new StoreError('unknown rule', 404);
      const key = existing?.key ?? store.nextRuleKey(wid(req));
      const title = String(req.body?.title || existing?.title || '').trim();
      const category = req.body?.category;
      if (category !== undefined && !isRuleCategory(category)) throw new StoreError(`category must be one of ${RULE_CATEGORIES.join(', ')}`);
      const documentId = documentIdOverride ?? (req.body?.documentId ? String(req.body.documentId) : null);
      if (documentId && !store.getDocument(wid(req), documentId)) throw new StoreError('unknown document', 404);
      // Values Legal set on the card are validated strictly (a bad value is a 400), compiled by
      // the one override engine, and recorded on the card with what Legal saw.
      let values;
      try {
        values = validateClauseValues(req.body?.values);
      } catch (err) {
        throw new StoreError((err as Error).message);
      }
      const base = await compileClause({
        text,
        key,
        title,
        citation: req.body?.citation ? String(req.body.citation) : undefined,
        category: category as RuleCategory | undefined,
        frameworkId: req.body?.frameworkId,
        values,
      });
      const { card, scope } = await cardWithImpact(req, text, key);
      const clause = { ...base, category: card.category, deontic: card.clause.deontic, compiled: card.clause.compiled };
      const created = store.createRuleDraft({
        workspaceId: wid(req),
        ruleId,
        title: title || clause.title,
        sourceText: text,
        clause,
        documentId,
        scope,
        card: storedCard(card),
        createdBy: userOf(res).id,
      });
      return created;
  };
  r.post(
    '/workspaces/:workspaceId/rules',
    need('editRules'),
    handle(async (req, res) => {
      res.status(201).json(await draftFromText(req, res, String(req.body?.rawLegalText || '').trim()));
    })
  );

  /** Recomputes "Coming up" for the workspace's repositories (local folders, and GitHub at the last scanned commit). */
  const refreshComingUp = async (workspaceId: string) => {
    for (const repo of store.listRepos(workspaceId)) {
      if (repo.source === 'local' && repo.localPath) {
        await storeComingUp(store, repo, 'working-tree', readRepositoryFilesAt(repo.localPath));
      } else if (options.readRepoFiles) {
        const latest = store.latestBranchScan(repo.id);
        if (latest) await storeComingUp(store, repo, latest.commitSha, await options.readRepoFiles(repo, latest.commitSha));
      }
    }
  };
  r.post(
    '/workspaces/:workspaceId/rule-versions/:versionId/approve',
    need('editRules'),
    handle(async (req, res) => {
      const effectiveFrom = req.body?.effectiveFrom ? String(req.body.effectiveFrom) : undefined;
      if (effectiveFrom && Number.isNaN(Date.parse(effectiveFrom))) throw new StoreError('effectiveFrom must be a date');
      const draft = store.getRuleVersion(wid(req), String(req.params.versionId));
      const open = ((draft?.card?.values ?? []) as Array<{ label: string; source: string }>).filter((v) => v.source === 'question');
      if (open.length) {
        throw new StoreError(`Set these values on the card before approving: ${open.map((v) => v.label).join(', ')}. A value the parser could not confirm is never enforced.`, 409);
      }
      const version = store.approveRuleVersion(wid(req), String(req.params.versionId), userOf(res).id, {
        effectiveFrom,
        answers: req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : undefined,
        note: req.body?.note ? String(req.body.note).slice(0, 2000) : undefined,
      });
      const evidence = await options.evidence?.ruleApproved(wid(req), version);
      // A version that takes effect later shows in "Coming up" right away.
      if ((version.effectiveFrom ?? '') > new Date().toISOString()) await refreshComingUp(wid(req));
      // Rescan main of every repository in scope, so the rule's failures show within a minute.
      const queuedScans: Array<{ repoId: string; jobId: string | null }> = [];
      if (options.enqueueBranchScan) {
        for (const repo of store.reposInScope(wid(req), version.scope)) {
          if (repo.source !== 'github') continue;
          queuedScans.push({ repoId: repo.id, jobId: options.enqueueBranchScan(repo, version) });
        }
      }
      // The default branch and every open pull request are re-checked against the new rule.
      await ruleDecided(flows, { workspaceId: wid(req), rule: store.getRule(wid(req), version.ruleId)!, version, decision: 'approved', userId: userOf(res).id });
      res.json({ ...version, queuedScans, evidenceSeq: evidence?.seq ?? null });
    })
  );
  r.post(
    '/workspaces/:workspaceId/rule-versions/:versionId/reject',
    need('editRules'),
    handle(async (req, res) => {
      const rejected = store.rejectRuleVersion(wid(req), String(req.params.versionId), userOf(res).id, String(req.body?.note || ''));
      await ruleDecided(flows, { workspaceId: wid(req), rule: store.getRule(wid(req), rejected.ruleId)!, version: rejected, decision: 'rejected', userId: userOf(res).id });
      res.json(rejected);
    })
  );
  /**
   * Moves the effective date of an approved version that isn't in effect yet: { effectiveFrom }.
   * A date today or earlier makes it take effect now, and the default branches in scope are rescanned.
   */
  r.post(
    '/workspaces/:workspaceId/rule-versions/:versionId/effective',
    need('editRules'),
    handle(async (req, res) => {
      const version = store.setEffectiveFrom(wid(req), String(req.params.versionId), String(req.body?.effectiveFrom ?? ''));
      await options.evidence?.ruleRescheduled(wid(req), version, userOf(res).id);
      const inEffect = (version.effectiveFrom ?? '') <= new Date().toISOString();
      const queuedScans: Array<{ repoId: string; jobId: string | null }> = [];
      if (inEffect && options.enqueueBranchScan) {
        for (const repo of store.reposInScope(wid(req), version.scope)) if (repo.source === 'github') queuedScans.push({ repoId: repo.id, jobId: options.enqueueBranchScan(repo, version) });
      }
      await refreshComingUp(wid(req));
      res.json({ ...version, inEffect, queuedScans });
    })
  );
  /**
   * A new draft version of a rule with a different scope: { all: true } or { counterpartyIds }.
   * It copies the text, clause and card of the latest version; Legal approves it as usual.
   */
  r.post(
    '/workspaces/:workspaceId/rules/:ruleId/rescope',
    need('editRules'),
    handle((req, res) => {
      const rule = store.getRule(wid(req), String(req.params.ruleId));
      if (!rule) throw new StoreError('unknown rule', 404);
      const latest = [...rule.versions].filter((v) => v.status === 'approved' || v.status === 'draft').sort((a, b) => b.version - a.version)[0];
      if (!latest) throw new StoreError('this rule has no version to copy', 409);
      const created = store.createRuleDraft({
        workspaceId: wid(req),
        ruleId: rule.id,
        title: rule.title,
        sourceText: latest.sourceText,
        clause: latest.clause,
        documentId: latest.documentId,
        scope: scopeFrom(store, wid(req), req.body),
        card: latest.card,
        createdBy: userOf(res).id,
      });
      res.status(201).json(created);
    })
  );
  r.post(
    '/workspaces/:workspaceId/rules/:ruleId/retire',
    need('editRules'),
    handle(async (req, res) => {
      store.retireRule(wid(req), String(req.params.ruleId), userOf(res).id);
      const rule = store.getRule(wid(req), String(req.params.ruleId))!;
      await options.evidence?.ruleRetired(wid(req), rule, userOf(res).id);
      await ruleDecided(flows, { workspaceId: wid(req), rule, decision: 'retired', userId: userOf(res).id });
      res.json(rule);
    })
  );
  r.get(
    '/workspaces/:workspaceId/rules-in-effect',
    need('view'),
    handle((req, res) => {
      const at = req.query.at ? String(req.query.at) : undefined;
      if (at && Number.isNaN(Date.parse(at))) throw new StoreError('at must be a date');
      const rules = store.rulesInEffect(wid(req), at ? new Date(at).toISOString() : undefined);
      res.json(rules.map((x) => ({ ...x, clause: { id: x.clause.id, title: x.clause.title, category: x.clause.category } })));
    })
  );

  // ---------------------------------------------------------------- exceptions and the Legal inbox (Phase 4)

  /** ?status=requested or several, comma separated (requested,approved). */
  r.get(
    '/workspaces/:workspaceId/exceptions',
    need('view'),
    handle((req, res) => {
      const wanted = String(req.query.status ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      for (const status of wanted) if (!EXCEPTION_STATUSES.includes(status as ExceptionStatus)) throw new StoreError(`status must be one of ${EXCEPTION_STATUSES.join(', ')}`);
      res.json(store.listExceptions(wid(req), { status: wanted.length ? (wanted as ExceptionStatus[]) : undefined }));
    })
  );
  /**
   * Engineers ask for an exception from the dashboard, with a reason and a scan, and:
   * - { findingIds: [...] }: one exception per finding (waived findings are skipped); returns a list; or
   * - { fingerprint }: one finding; or { ruleKey, pathGlob }: every finding of a rule under a path;
   *   returns the exception (200 when that request is already open, else 201).
   */
  r.post(
    '/workspaces/:workspaceId/exceptions',
    need('requestExceptions'),
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scan = store.getScan(wid(req), String(body.scanId || ''));
      if (!scan) throw new StoreError('scan not found', 404);
      const findings = store.listFindings(scan.id);
      const user = userOf(res);
      const ask = { workspaceId: wid(req), reason: String(body.reason ?? ''), requestedBy: user.id, requesterLabel: user.name ?? user.email ?? 'A member', via: 'dashboard' as const };
      const ref = (f: StoredFinding) => ({ ruleId: f.ruleId, ruleKey: f.ruleKey, repoId: scan.repoId, scanId: scan.id, prNumber: scan.prNumber });
      if (Array.isArray(body.findingIds)) {
        const ids = new Set(body.findingIds.map(String));
        const chosen = findings.filter((f) => ids.has(f.id) && f.state !== 'waived');
        if (chosen.length === 0) throw new StoreError('choose at least one finding that is not already waived');
        const records = await requestExceptions(flows, { ...ask, findings: chosen.map((f) => ({ ...ref(f), fingerprint: f.fingerprint, filePath: f.filePath, startLine: f.startLine, message: f.message })) });
        return void res.status(201).json(records);
      }
      let finding: StoredFinding | undefined;
      if (body.fingerprint) {
        finding = findings.find((x) => x.fingerprint === String(body.fingerprint));
        if (!finding) throw new StoreError('that finding is not in this scan', 404);
      } else {
        finding = findings.find((x) => x.ruleKey === String(body.ruleKey || ''));
        if (!finding) throw new StoreError('this scan has no finding of that rule', 404);
      }
      const one = body.fingerprint
        ? { ...ref(finding), fingerprint: finding.fingerprint, filePath: finding.filePath, startLine: finding.startLine, message: finding.message }
        : { ...ref(finding), pathGlob: String(body.pathGlob || '') };
      const [record] = await requestExceptions(flows, { ...ask, findings: [one] });
      res.status(record.created ? 201 : 200).json(record);
    })
  );
  const decide = (decision: 'approved' | 'rejected') =>
    handle(async (req, res) => {
      const e = await decideException(flows, {
        workspaceId: wid(req),
        exceptionId: String(req.params.exceptionId),
        decision,
        userId: userOf(res).id,
        note: String(req.body?.note || ''),
        expiresAt: req.body?.expiresAt ? String(req.body.expiresAt) : null,
      });
      res.json(options.onExceptionDecided ? { ...e, rerunJobId: options.onExceptionDecided(e) ?? e.rerunJobId } : e);
    });
  /** Legal approves with a reason and a required expiry date: { note, expiresAt }. */
  r.post('/workspaces/:workspaceId/exceptions/:exceptionId/approve', need('decideExceptions'), decide('approved'));
  r.post('/workspaces/:workspaceId/exceptions/:exceptionId/reject', need('decideExceptions'), decide('rejected'));
  /** Test-only admin action (guide, Phase 4 test): move an exception's expiry, for example to yesterday. */
  r.post(
    '/workspaces/:workspaceId/exceptions/:exceptionId/expiry',
    need('view'),
    handle(async (req, res) => {
      if (!isAdmin(res)) throw new StoreError('only administrators can change an expiry date', 403);
      const at = String(req.body?.expiresAt || '');
      if (Number.isNaN(Date.parse(at))) throw new StoreError('expiresAt must be a date');
      store.setExceptionExpiry(wid(req), String(req.params.exceptionId), at);
      await expireExceptions(flows);
      res.json(store.getException(wid(req), String(req.params.exceptionId)));
    })
  );
  /** What waits for Legal: exception requests and rule drafts. */
  r.get('/workspaces/:workspaceId/inbox', need('view'), (req, res) => {
    const drafts = store
      .listRules(wid(req))
      .flatMap((rule) => rule.versions.filter((v) => v.status === 'draft').map((v) => ({ ruleId: rule.id, ruleKey: rule.key, title: rule.title, versionId: v.id, version: v.version, createdAt: v.createdAt })));
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const feedDrafts = store.listFeedItems(wid(req)).filter((i) => i.kind === 'TEXT' && !i.documentId && i.firstSeenAt >= recent);
    res.json({ exceptionRequests: store.listExceptions(wid(req), { status: 'requested' }), ruleDrafts: drafts, feedDrafts });
  });

  // ---------------------------------------------------------------- coming up and the regulation feed (Phase 6)

  /** Approved versions that take effect later, and what they find on each default branch. */
  r.get('/workspaces/:workspaceId/coming-up', need('view'), (req, res) =>
    res.json({ upcoming: store.upcomingRules(wid(req)).map((r) => ({ ruleKey: r.ruleKey, versionId: r.versionId, version: r.version, title: r.clause.title, effectiveFrom: r.effectiveFrom })), results: store.listComingUp(wid(req)) })
  );
  r.post(
    '/workspaces/:workspaceId/coming-up/refresh',
    need('runScans'),
    handle(async (req, res) => {
      await refreshComingUp(wid(req));
      res.json({ results: store.listComingUp(wid(req)) });
    })
  );
  /** Federal Register and EUR-Lex items, newest first, with the document this workspace made from each. */
  r.get('/workspaces/:workspaceId/feed', need('view'), (req, res) => res.json(store.listFeedItems(wid(req), Number(req.query.limit) || 100)));
  /**
   * Regulation watch now: the rules each recent feed item may affect, and (with the workspace's AI on)
   * a short summary from the item's own text. Five items per call; it never drafts or approves.
   */
  r.post(
    '/workspaces/:workspaceId/feed/watch',
    need('editRules'),
    handle(async (req, res) => {
      res.json(await watchRegulationFeed({ store, ai, events: flows }, wid(req), { limit: 5 }));
    })
  );
  r.post(
    '/workspaces/:workspaceId/feed/refresh',
    need('editRules'),
    handle(async (_req, res) => {
      if (!options.refreshFeed) throw new StoreError('the regulation feed is not configured on this server', 501);
      res.json({ added: await options.refreshFeed() });
    })
  );
  /**
   * "Draft rule change": turns a feed item into a regulation document and a draft linked to it,
   * a new rule or (with { ruleId }) a new version of one. Nothing takes effect until Legal approves.
   */
  r.post(
    '/workspaces/:workspaceId/feed/:itemId/draft',
    need('editRules'),
    handle(async (req, res) => {
      const item = store.getFeedItem(wid(req), String(req.params.itemId));
      if (!item) throw new StoreError('unknown feed item', 404);
      if (item.kind === 'CHANGE_NOTICE') throw new StoreError('this item announces a change to another act and has no text to compile; open the amended act and upload the new text', 409);
      const documentId =
        item.documentId ??
        store.addDocument({ workspaceId: wid(req), kind: 'regulation', title: item.title, language: 'en', text: item.excerpt, uploadedBy: userOf(res).id }).id;
      store.linkDocumentToFeedItem(wid(req), documentId, item.id, item.url);
      req.body = { citation: `${item.source === 'EUR_LEX' ? 'EUR-Lex' : 'Federal Register'} ${item.documentNumber}`, title: item.title.slice(0, 200), ...(req.body ?? {}) };
      const created = await draftFromText(req, res, item.excerpt.trim(), documentId);
      res.status(201).json({ ...created, documentId, feedItemId: item.id });
    })
  );

  /**
   * "Fetch the act's text": the amended act's full text from its official source (EUR-Lex's Cellar
   * interface or the Federal Register API), stored as a regulation document linked to the item.
   * Idempotent: an item whose full act text was already fetched returns that document. A document
   * linked by "Draft rule change" holds only the short feed excerpt, so it does not count; the act is
   * then fetched and stored as its own document. Concurrent requests for one item share one fetch.
   */
  const fetching = new Map<string, Promise<{ id: string; created: boolean }>>();
  r.post(
    '/workspaces/:workspaceId/feed/:itemId/fetch-text',
    need('editRules'),
    handle(async (req, res) => {
      const workspaceId = wid(req);
      const item = store.getFeedItem(workspaceId, String(req.params.itemId));
      if (!item) throw new StoreError('unknown feed item', 404);
      const uploadedBy = userOf(res).id;
      const key = `${workspaceId}\u0000${item.id}`;
      let job = fetching.get(key);
      if (!job) {
        job = (async () => {
          const known = store.findActTextDocument(workspaceId, item.id);
          if (known) return { id: known, created: false };
          const act = await fetchActText(item, options.actText);
          // Re-read after the network call: another process or request may have stored it meanwhile.
          const raced = store.findActTextDocument(workspaceId, item.id);
          if (raced) return { id: raced, created: false };
          const doc = store.addDocument({ workspaceId, kind: 'regulation', title: act.title, language: 'en', text: act.text, uploadedBy, fileFormat: 'official-text' });
          store.linkDocumentToFeedItem(workspaceId, doc.id, item.id, act.sourceUrl);
          return { id: doc.id, created: true };
        })().finally(() => fetching.delete(key));
        fetching.set(key, job);
      }
      const { id, created } = await job;
      const doc = store.getDocument(workspaceId, id)!;
      res.status(created ? 201 : 200).json({ ...doc, clauses: splitClauses(doc.text) });
    })
  );
  /** Which optional integrations this server has (the workspace shows "Import from URL" only with Browserbase). */
  r.get('/workspaces/:workspaceId/integrations', need('view'), (_req, res) => {
    const key = options.actText?.browserbaseKey === undefined ? process.env.BROWSERBASE_API_KEY : options.actText.browserbaseKey;
    res.json({ browserbase: Boolean(key) });
  });
  /** "Import from URL": { url, title?, kind?, counterpartyId?, language? }; a public page through Browserbase Fetch. */
  r.post(
    '/workspaces/:workspaceId/documents/from-url',
    need('editRules'),
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = String(body.kind || 'regulation');
      if (!['contract', 'regulation', 'policy'].includes(kind)) throw new StoreError('kind must be contract, regulation or policy');
      const page = await fetchUrlText(String(body.url || ''), options.actText);
      const doc = store.addDocument({
        workspaceId: wid(req),
        counterpartyId: body.counterpartyId ? String(body.counterpartyId) : null,
        kind: kind as 'contract' | 'regulation' | 'policy',
        title: String(body.title || page.title),
        language: body.language ? String(body.language).slice(0, 10) : null,
        text: page.text,
        uploadedBy: userOf(res).id,
      });
      store.linkDocumentToFeedItem(wid(req), doc.id, null, page.sourceUrl);
      res.status(201).json({ ...store.getDocument(wid(req), doc.id), clauses: splitClauses(page.text) });
    })
  );

  // ---------------------------------------------------------------- share links and the evidence log (Phase 5)

  r.get('/workspaces/:workspaceId/shares', need('createShares'), (req, res) => res.json(store.listShares(wid(req))));
  /**
   * { ruleIds?, periodFrom, periodTo, expiresAt, counterpartyId?, label? } → the link, shown once.
   * Without ruleIds the share covers every rule that has been approved. The auditor sees those
   * rules' history, checks and exceptions in the period, with signed evidence.
   */
  r.post(
    '/workspaces/:workspaceId/shares',
    need('createShares'),
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      let ruleIds: string[];
      if (Array.isArray(body.ruleIds)) ruleIds = body.ruleIds.map(String);
      else {
        ruleIds = store.currentRuleIds(wid(req));
        if (ruleIds.length === 0) throw new StoreError('approve a rule before sharing evidence');
      }
      const { token, share } = store.createShare({
        workspaceId: wid(req),
        label: body.label ? String(body.label) : null,
        counterpartyId: body.counterpartyId ? String(body.counterpartyId) : null,
        ruleIds,
        periodFrom: String(body.periodFrom ?? ''),
        periodTo: String(body.periodTo ?? ''),
        expiresAt: String(body.expiresAt ?? ''),
        createdBy: userOf(res).id,
      });
      await options.evidence?.shareChanged(share, 'created', userOf(res).id);
      res.status(201).json({ ...share, token, url: `${publicUrl}/share/${token}` });
    })
  );
  r.post(
    '/workspaces/:workspaceId/shares/:shareId/revoke',
    need('createShares'),
    handle(async (req, res) => {
      const before = store.getShare(wid(req), String(req.params.shareId));
      const share = store.revokeShare(wid(req), String(req.params.shareId));
      if (!before?.revokedAt) await options.evidence?.shareChanged(share, 'revoked', userOf(res).id);
      res.json(share);
    })
  );
  /** Who opened a share: time, IP and browser of each view or download. */
  r.get(
    '/workspaces/:workspaceId/shares/:shareId/views',
    need('createShares'),
    handle((req, res) => {
      if (!store.getShare(wid(req), String(req.params.shareId))) throw new StoreError('unknown share', 404);
      res.json(store.listShareViews(String(req.params.shareId)));
    })
  );
  /**
   * The workspace's evidence records, newest first, each with its signed header, its body and one
   * plain line: { count, keys, entries }. ?limit= (default 100, up to 1000), ?from=&to=.
   */
  r.get(
    '/workspaces/:workspaceId/evidence',
    need('view'),
    handle(async (req, res) => {
      const log = options.evidence?.log;
      if (!log) return void res.json({ count: 0, keys: [], entries: [] });
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
      const entries = log.list(wid(req), { from: req.query.from ? String(req.query.from) : undefined, to: req.query.to ? String(req.query.to) : undefined, latest: limit }).reverse();
      res.json({
        count: log.count(wid(req)),
        keys: await keysFor(wid(req)),
        entries: entries.map((e) => ({ seq: e.seq, header: e.header, headerJson: e.headerJson, headerSha256: e.headerSha256, signature: e.signature, body: e.body, bodyJson: e.bodyJson, ...describeEvidence(e) })),
      });
    })
  );

  // ---------------------------------------------------------------- personal access tokens (Phase 4a)

  /** Workspace owners (and administrators) see and revoke everyone's tokens. */
  const ownerView = (req: Request, res: Response) => {
    const role = roleIn(req, res);
    return role === 'admin' || role === 'owner';
  };
  /** The caller's own tokens for the MCP endpoint (owners: everyone's with ?all=1), and the endpoint's address. */
  r.get('/workspaces/:workspaceId/tokens', need('view'), (req, res) => {
    const all = ownerView(req, res) && req.query.all === '1';
    res.json({ mcpUrl: options.mcpUrl ?? `${publicUrl}/mcp`, tokens: all ? store.listAllApiTokens(wid(req)) : store.listApiTokens(wid(req), userOf(res).id) });
  });
  /** { name, days? } → the token, shown once. It acts as the caller, with the caller's role. */
  r.post(
    '/workspaces/:workspaceId/tokens',
    need('view'),
    handle((req, res) => {
      const days = req.body?.days === undefined ? undefined : Number(req.body.days);
      const { token, record } = store.createApiToken(wid(req), userOf(res).id, String(req.body?.name ?? ''), days);
      res.status(201).json({ ...record, token, mcpUrl: options.mcpUrl ?? `${publicUrl}/mcp` });
    })
  );
  r.post(
    '/workspaces/:workspaceId/tokens/:tokenId/revoke',
    need('view'),
    handle((req, res) => res.json(store.revokeApiToken(wid(req), userOf(res).id, String(req.params.tokenId), { canRevokeOthers: ownerView(req, res) })))
  );
  /** The full MCP call log: time, token, tool, repository, outcome and duration (owners). The members' activity list is /assistant-calls. */
  // ---- Event webhook (one per workspace, owner only): scans, regulation watch and exceptions go to a URL such as an n8n workflow.
  const webhookView = (w: NonNullable<ReturnType<typeof store.getWorkspaceWebhook>>) => ({ configured: true, url: w.url, events: w.events, createdAt: w.createdAt, updatedAt: w.updatedAt, availableEvents: EVENT_TYPES });
  r.get(
    '/workspaces/:workspaceId/webhook',
    need('manageWorkspace'),
    handle((req, res) => {
      const w = store.getWorkspaceWebhook(wid(req));
      res.json(w ? webhookView(w) : { configured: false, availableEvents: EVENT_TYPES });
    })
  );
  r.put(
    '/workspaces/:workspaceId/webhook',
    need('manageWorkspace'),
    handle(async (req, res) => {
      const body = (req.body ?? {}) as { url?: unknown; events?: unknown; rotateSecret?: unknown };
      if (typeof body.url !== 'string' || !body.url.trim()) throw new StoreError('url is required');
      const events = body.events === undefined ? [...EVENT_TYPES] : body.events;
      if (!Array.isArray(events) || events.length === 0 || events.some((e) => !(EVENT_TYPES as readonly unknown[]).includes(e))) {
        throw new StoreError(`events must be a non-empty list of: ${EVENT_TYPES.join(', ')}`);
      }
      const url = body.url.trim();
      await checkWebhookUrl(url);
      const { webhook, newSecret } = store.setWorkspaceWebhook(wid(req), { url, events: events as string[], rotateSecret: body.rotateSecret === true, createdBy: userOf(res).id });
      // The secret is shown once, when it is made or rotated. Receivers need it to check the signature.
      res.status(newSecret ? 201 : 200).json({ ...webhookView(webhook), ...(newSecret ? { secret: newSecret } : {}) });
    })
  );
  r.delete(
    '/workspaces/:workspaceId/webhook',
    need('manageWorkspace'),
    handle((req, res) => res.json({ deleted: store.deleteWorkspaceWebhook(wid(req)) }))
  );
  r.post(
    '/workspaces/:workspaceId/webhook/test',
    need('manageWorkspace'),
    handle(async (req, res) => {
      if (!store.getWorkspaceWebhook(wid(req))) throw new StoreError('this workspace has no webhook yet', 409);
      // One test at a time per workspace, and not more often than every few seconds: each holds a request open.
      const id = wid(req);
      if (testInFlight.has(id) || Date.now() - (testSentAt.get(id) ?? 0) < Number(process.env.LEXCOMPILER_WEBHOOK_TEST_COOLDOWN_MS ?? 5000)) throw new StoreError('a test event was just sent; wait a few seconds and try again', 429);
      testInFlight.add(id);
      testSentAt.set(id, Date.now());
      try {
        res.json(await sendTestEvent({ store, queue: null, publicUrl }, id, { message: 'This is a test event from LexCompiler.', url: publicUrl }));
      } finally {
        testInFlight.delete(id);
      }
    })
  );
  r.get('/workspaces/:workspaceId/webhook/deliveries', need('manageWorkspace'), (req, res) => res.json(store.listOutboundDeliveries(wid(req))));
  r.get('/workspaces/:workspaceId/mcp/calls', need('manageWorkspace'), (req, res) => res.json(store.listMcpCalls(wid(req), Number(req.query.limit) || 50)));

  // ---------------------------------------------------------------- scans

  r.get('/workspaces/:workspaceId/scans', need('view'), (req, res) =>
    res.json(store.listScans(wid(req), { repoId: req.query.repoId ? String(req.query.repoId) : undefined, limit: Number(req.query.limit) || 50 }))
  );
  r.get(
    '/workspaces/:workspaceId/scans/:scanId',
    need('view'),
    handle((req, res) => {
      const scan = store.getScan(wid(req), String(req.params.scanId));
      if (!scan) throw new StoreError('scan not found', 404);
      res.json({ ...scan, findings: store.listFindings(scan.id) });
    })
  );
  /**
   * "Open fix PR": one commit fixing every finding on the default branch, opened only when Z3
   * proves every rule after the patch. Returns the existing PR for the same base commit.
   */
  r.post(
    '/workspaces/:workspaceId/repos/:repoId/fix-pr',
    need('runScans'),
    handle(async (req, res) => {
      const repo = store.getRepo(String(req.params.repoId));
      if (!repo || repo.workspaceId !== wid(req)) throw new StoreError('repository not found', 404);
      if (repo.source !== 'github') throw new StoreError('fix pull requests are opened on GitHub repositories; apply the fix to a local folder by hand', 409);
      if (!options.openFixPr) throw new StoreError('the GitHub App is not configured on this server', 503);
      const user = userOf(res);
      const result = await options.openFixPr(repo, user.email ?? user.name ?? user.oidcSub);
      res.status(result.created ? 201 : 200).json(result);
    })
  );
  r.get('/workspaces/:workspaceId/repos/:repoId/fix-prs', need('view'), (req, res) => {
    const repo = store.getRepo(String(req.params.repoId));
    if (!repo || repo.workspaceId !== wid(req)) return void res.status(404).json({ error: 'repository not found' });
    res.json(store.listFixPrs(repo.id));
  });
  /**
   * Runs the six agents on the repository's default branch with the rules in effect. With
   * "openPullRequest", a patch that passes the Z3 gate becomes a fix pull request; with
   * "useModels" (server operator only, it spends the agents' budget) each agent's model reports too.
   */
  r.post(
    '/workspaces/:workspaceId/repos/:repoId/crew-runs',
    need('runScans'),
    handle(async (req, res) => {
      const repo = store.getRepo(String(req.params.repoId));
      if (!repo || repo.workspaceId !== wid(req)) throw new StoreError('repository not found', 404);
      if (!options.crew) throw new StoreError('the agent crew is not available on this server', 503);
      const useModels = req.body?.useModels === true;
      if (useModels && principalOf(res)?.globalRole !== 'admin') throw new StoreError('running the crew with models is for the server operator', 403);
      const user = userOf(res);
      const run = await options.crew.run(repo, {
        useModels,
        openPullRequest: req.body?.openPullRequest === true,
        // Every rule in effect, not only those today's feed touches.
        allRules: req.body?.allRules === true,
        requestedBy: user.email ?? user.name ?? user.oidcSub,
        triggeredBy: user.email ?? user.oidcSub,
      });
      res.status(201).json(run);
    })
  );
  r.get('/workspaces/:workspaceId/crew-runs', need('view'), (req, res) => {
    if (!options.crew) return void res.json({ runs: [] });
    res.json({ runs: options.crew.runs.list(wid(req)) });
  });
  r.get('/workspaces/:workspaceId/crew-runs/:runId', need('view'), (req, res) => {
    const run = options.crew?.runs.get(String(req.params.runId), wid(req));
    if (!run) return void res.status(404).json({ error: 'crew run not found' });
    res.json(run);
  });

  /** Scans a local repository with the rules in effect. GitHub repositories are scanned by the app. */
  r.post(
    '/workspaces/:workspaceId/repos/:repoId/scan',
    need('runScans'),
    handle(async (req, res) => {
      const repo = store.getRepo(String(req.params.repoId));
      if (!repo || repo.workspaceId !== wid(req)) throw new StoreError('repository not found', 404);
      if (repo.source !== 'local' || !repo.localPath) throw new StoreError('GitHub repositories are scanned on push and pull request', 409);
      // Each rule is proven only on the paths in its scope (scanLocalRepo, Phase 6).
      const { scan, evidence } = await scanLocalRepo({ store, evidence: options.evidence, events: flows }, repo, 'manual');
      res.json({ ...scan, findings: store.listFindings(scan.id), evidence });
    })
  );

  options.extra?.(r, { userOf, roleIn, need, isAdmin, handle, wid, flows, evidence: options.evidence?.log ?? null, keysFor, oidcEnabled: Boolean(oidc) });
  return r;
}
