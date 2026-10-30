import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readRepositoryFilesAt } from '../analyzer/repoBaseline.js';
import { AiGateway, localModelConfig, modelForTask } from '../ai/gateway.js';
import { OidcProvider, type Principal, type SessionStore } from '../auth/oidc.js';
import { tokensMatch, type Authenticator } from '../security.js';
import { lexcompilerVersion } from '../util/versions.js';
import type { RuleCategory } from '../../shared/types.js';
import { compileClause, isRuleCategory, libraryTemplates, RULE_CATEGORIES, validateClauseValues } from './clauses.js';
import { classifyFindings, scanFiles, type ClassifiedFinding } from './scanner.js';
import { scanConclusion, summarizeFindings } from './summary.js';
import { can, ProductStore, StoreError, WORKSPACE_ROLES, type Permission, type Rule, type RuleVersion, type ScanRecord, type User, type WorkspaceRole } from './store.js';

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
}

export interface ProductRouterOptions {
  /** Local repositories must live inside this directory. */
  reposRoot: string;
  /** Model calls; defaults to a gateway on the store's database. */
  ai?: AiGateway;
  /** Called after Legal approves, rejects or retires a rule (evidence, re-checks). */
  onRuleDecided?: (input: { workspaceId: string; rule: Rule; version?: RuleVersion; decision: 'approved' | 'rejected' | 'retired'; userId: string }) => void;
  /** Mounts more workspace routes with the same access checks. */
  extra?: (r: express.Router, helpers: RouteHelpers) => void;
  /** Email and password sign-in is on (reported by /auth/config). */
  passwordSignIn?: boolean;
  /** Called after a scan started from the dashboard finishes (evidence). */
  onScanCompleted?: (scan: ScanRecord, findings: ClassifiedFinding[]) => void;
}

/** Sign-in endpoints and the workspace API (members, repositories, rules, scans). */
export function createProductRouter(store: ProductStore, oidc: OidcProvider | null, options: ProductRouterOptions) {
  const r = express.Router();
  const reposRoot = path.resolve(options.reposRoot);
  const ai = options.ai ?? new AiGateway(store.db);

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

  // ---------------------------------------------------------------- rules

  r.get('/library/templates', (_req, res) => res.json(libraryTemplates()));
  r.get('/workspaces/:workspaceId/rules', need('view'), (req, res) => res.json(store.listRules(wid(req))));
  r.post(
    '/workspaces/:workspaceId/rules',
    need('editRules'),
    handle(async (req, res) => {
      const text = String(req.body?.rawLegalText || '').trim();
      if (!text) throw new StoreError('rawLegalText is required');
      if (text.length > 20000) throw new StoreError('rawLegalText is too long (max 20000 characters)');
      const ruleId = req.body?.ruleId ? String(req.body.ruleId) : undefined;
      const existing = ruleId ? store.getRule(wid(req), ruleId) : undefined;
      if (ruleId && !existing) throw new StoreError('unknown rule', 404);
      const key = existing?.key ?? store.nextRuleKey(wid(req));
      const title = String(req.body?.title || existing?.title || '').trim();
      const category = req.body?.category;
      if (category !== undefined && !isRuleCategory(category)) throw new StoreError(`category must be one of ${RULE_CATEGORIES.join(', ')}`);
      const documentId = req.body?.documentId ? String(req.body.documentId) : null;
      if (documentId && !store.getDocument(wid(req), documentId)) throw new StoreError('unknown document', 404);
      let values;
      try {
        values = validateClauseValues(req.body?.values);
      } catch (err) {
        throw new StoreError((err as Error).message);
      }
      const clause = await compileClause({
        text,
        key,
        title,
        citation: req.body?.citation ? String(req.body.citation) : undefined,
        category: category as RuleCategory | undefined,
        frameworkId: req.body?.frameworkId,
        values,
      });
      const created = store.createRuleDraft({
        workspaceId: wid(req),
        ruleId,
        title: title || clause.title,
        sourceText: text,
        clause,
        documentId,
        createdBy: userOf(res).id,
      });
      res.status(201).json(created);
    })
  );
  r.post(
    '/workspaces/:workspaceId/rule-versions/:versionId/approve',
    need('editRules'),
    handle((req, res) => {
      const effectiveFrom = req.body?.effectiveFrom ? String(req.body.effectiveFrom) : undefined;
      if (effectiveFrom && Number.isNaN(Date.parse(effectiveFrom))) throw new StoreError('effectiveFrom must be a date');
      const approved = store.approveRuleVersion(wid(req), String(req.params.versionId), userOf(res).id, {
        effectiveFrom,
        answers: req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : undefined,
        note: req.body?.note ? String(req.body.note).slice(0, 2000) : undefined,
      });
      options.onRuleDecided?.({ workspaceId: wid(req), rule: store.getRule(wid(req), approved.ruleId)!, version: approved, decision: 'approved', userId: userOf(res).id });
      res.json(approved);
    })
  );
  r.post(
    '/workspaces/:workspaceId/rule-versions/:versionId/reject',
    need('editRules'),
    handle((req, res) => {
      const rejected = store.rejectRuleVersion(wid(req), String(req.params.versionId), userOf(res).id, String(req.body?.note || ''));
      options.onRuleDecided?.({ workspaceId: wid(req), rule: store.getRule(wid(req), rejected.ruleId)!, version: rejected, decision: 'rejected', userId: userOf(res).id });
      res.json(rejected);
    })
  );
  r.post(
    '/workspaces/:workspaceId/rules/:ruleId/retire',
    need('editRules'),
    handle((req, res) => {
      store.retireRule(wid(req), String(req.params.ruleId), userOf(res).id);
      const rule = store.getRule(wid(req), String(req.params.ruleId))!;
      options.onRuleDecided?.({ workspaceId: wid(req), rule, decision: 'retired', userId: userOf(res).id });
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
  /** Scans a local repository with the rules in effect. GitHub repositories are scanned by the app. */
  r.post(
    '/workspaces/:workspaceId/repos/:repoId/scan',
    need('runScans'),
    handle(async (req, res) => {
      const repo = store.getRepo(String(req.params.repoId));
      if (!repo || repo.workspaceId !== wid(req)) throw new StoreError('repository not found', 404);
      if (repo.source !== 'local' || !repo.localPath) throw new StoreError('GitHub repositories are scanned on push and pull request', 409);
      const rules = store.rulesInEffect(wid(req));
      const scan = store.createScan({ repoId: repo.id, commitSha: 'working-tree', trigger: 'manual', rules, lexcompilerVersion: lexcompilerVersion() });
      try {
        const result = await scanFiles(readRepositoryFilesAt(repo.localPath), rules);
        const findings = classifyFindings(result.findings, null, store.activeExceptions(wid(req), repo.id));
        const summary = summarizeFindings(findings, result.undecidedRuleKeys);
        const done = store.completeScan(scan.id, {
          conclusion: scanConclusion(summary, false),
          filesScanned: result.filesScanned,
          summary,
          facts: result.facts,
          findings,
        });
        options.onScanCompleted?.(done, findings);
        res.json({ ...done, findings: store.listFindings(scan.id) });
      } catch (err) {
        store.failScan(scan.id, (err as Error).message);
        throw err;
      }
    })
  );

  options.extra?.(r, { userOf, roleIn, need, isAdmin, handle, wid });
  return r;
}
