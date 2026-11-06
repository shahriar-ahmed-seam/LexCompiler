import express from 'express';
import type { Request, Response } from 'express';
import type { AiGateway } from '../ai/gateway.js';
import { OidcProvider } from '../auth/oidc.js';
import { RateLimiter, verifyPassword } from '../auth/passwords.js';
import { describeEvidence } from '../evidence/describe.js';
import type { RuleCategory } from '../../shared/types.js';
import { isRuleCategory, RULE_CATEGORIES, validateClauseValues } from './clauses.js';
import { revokeException } from './flows.js';
import type { GovernanceStore } from './governance.js';
import { analyzeRule, CATEGORY_LABELS, plainReading } from './ruleCard.js';
import type { RouteHelpers } from './router.js';
import { StoreError, type ProductStore } from './store.js';

/**
 * The workspace routes only the web app uses: sign-in with a password, the overview, the rule
 * list and rule analysis, revoking an exception, verifying the evidence, the assistants' activity
 * and the plan and usage. Everything else (rules, exceptions, shares, tokens, evidence) is in
 * router.ts. Mounted inside the product router (`extra`), so the same role checks apply.
 */
export interface WorkspaceRouteDeps {
  store: ProductStore;
  gov: GovernanceStore;
  ai: AiGateway;
  passwordSignIn: boolean;
  /** Secure cookies when the public URL is https. */
  secureCookies: boolean;
  /** Origins that may post to /auth/password (LEXCOMPILER_ALLOWED_ORIGINS); the server's own origin is always allowed. */
  allowedOrigins?: string[];
}

export const PLANS: Record<string, { label: string; seats: number; repos: number }> = {
  pilot: { label: 'Pilot', seats: 10, repos: 5 },
  team: { label: 'Team', seats: 25, repos: 20 },
};

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const startOfDay = () => new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
const startOfMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

export function mountWorkspaceRoutes(r: express.Router, h: RouteHelpers, deps: WorkspaceRouteDeps): void {
  const { store, gov, ai } = deps;
  const evidence = h.evidence;
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const cookie = (value: string, maxAgeS: number) => `lexc_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${deps.secureCookies ? '; Secure' : ''}`;

  // ---------------------------------------------------------------- password sign-in

  /** A browser form from another site must not sign anyone in: Origin, when present, must be this server's own or allowed. */
  const originAllowed = (req: Request) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    return origin === `${req.protocol}://${req.get('host')}` || (deps.allowedOrigins ?? []).includes(origin);
  };
  if (deps.passwordSignIn) {
    r.post('/auth/password', async (req: Request, res: Response) => {
      if (!originAllowed(req)) return void res.status(403).json({ error: 'This origin is not allowed to sign in.' });
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      // Only failed attempts count, so people sharing an address (a tunnel, an office) aren't locked out by sign-ins.
      const key = `${ip}|${email}`;
      if (loginLimiter.blocked(key)) return void res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      const user = email ? gov.findUserByEmail(email) : undefined;
      const ok = await verifyPassword(password, user?.passwordHash);
      if (!user || !ok) {
        loginLimiter.take(key);
        return void res.status(400).json({ error: 'That email and password don’t match an account.' });
      }
      const sessionId = store.createSession({ sub: user.sub, email: user.email ?? undefined, emailVerified: true, name: user.name ?? undefined, globalRole: 'member', via: 'password-session' }, SESSION_TTL_MS);
      store.upsertUser({ sub: user.sub });
      res.setHeader('Set-Cookie', cookie(sessionId, SESSION_TTL_MS / 1000));
      res.json({ signedIn: true });
    });
  }
  // With OIDC on, the router ends sessions through the identity provider; otherwise this does.
  if (!h.oidcEnabled) {
    r.post('/auth/logout', (req, res) => {
      const sid = OidcProvider.sessionIdFromCookies(req.headers.cookie);
      if (sid) store.deleteSession(sid);
      res.setHeader('Set-Cookie', cookie('', 0));
      res.json({ signedOut: true });
    });
  }

  const ws = h.wid;
  const actor = (res: Response) => h.userOf(res);

  // ---------------------------------------------------------------- overview

  r.get(
    '/workspaces/:workspaceId/overview',
    h.need('view'),
    h.handle((req, res) => {
      const id = ws(req);
      const workspace = store.getWorkspace(id)!;
      const meta = gov.workspaceMeta(id);
      const rules = store.listRules(id);
      const inEffect = store.rulesInEffect(id);
      const now = new Date().toISOString();
      const drafts = rules.filter((x) => x.versions.some((v) => v.status === 'draft')).length;
      const scheduled = rules.filter((x) => x.versions.some((v) => v.status === 'approved' && (v.effectiveFrom ?? '') > now)).length;
      const exceptions = gov.listExceptions(id, ['requested', 'approved']);
      const settings = ai.settings(id);
      const repos = store.listRepos(id).map((repo) => {
        const branch = gov.latestBranchScan(repo.id);
        const branchScan = branch ? store.getScanById(branch.id) : undefined;
        const prs = gov.latestPullRequestScans(repo.id).slice(0, 8).map((p) => ({ ...p, summary: store.getScanById(p.scanId)?.summary ?? null }));
        return { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, source: repo.source, lastScan: branchScan ? { id: branchScan.id, commitSha: branchScan.commitSha, conclusion: branchScan.conclusion, finishedAt: branchScan.finishedAt, summary: branchScan.summary } : null, pullRequests: prs };
      });
      const evidenceTail = evidence ? evidence.list(id, { latest: 30 }).reverse() : [];
      const mcp = gov.listMcpCalls(id, 10);
      const activity = [
        ...evidenceTail.map((e) => ({ at: e.header.at, seq: e.seq, ...describeEvidence(e) })),
        ...mcp.map((c) => ({ at: c.createdAt, seq: null, kind: 'assistant', text: `${c.userName ?? 'A member'}'s assistant${c.client ? ` (${c.client})` : ''} ran ${c.tool}${c.repo ? ` on ${c.repo}` : ''}${c.summary ? `: ${c.summary}` : ''}`, link: '/app/assistants' })),
      ]
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, 20);
      res.json({
        workspace: { ...workspace, plan: meta.plan, planLabel: PLANS[meta.plan]?.label ?? meta.plan },
        role: h.roleIn(req, res),
        counts: {
          rulesInEffect: inEffect.length,
          drafts,
          scheduled,
          exceptionsWaiting: exceptions.filter((e) => e.status === 'requested').length,
          exceptionsActive: exceptions.filter((e) => e.status === 'approved').length,
          evidenceRecords: evidence?.count(id) ?? 0,
          members: store.listMembers(id).length,
          aiMode: settings.mode,
          aiTokensToday: ai.tokensUsedToday(id),
          aiDailyBudget: ai.effectiveBudget(id),
          assistantCallsToday: gov.countSince('mcp_calls', id, startOfDay()),
        },
        repos,
        activity,
      });
    })
  );

  // ---------------------------------------------------------------- rules, for the web app

  r.get('/workspaces/:workspaceId/rule-list', h.need('view'), (req, res) => {
    const id = ws(req);
    const now = new Date().toISOString();
    const inEffect = new Map(store.rulesInEffect(id).map((x) => [x.ruleId, x.versionId]));
    const rules = store.listRules(id);
    const names = gov.people(rules.flatMap((x) => x.versions.flatMap((v) => [v.approvedBy ?? '', v.createdBy])));
    res.json(
      rules.map((rule) => {
        const versions = rule.versions.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status,
          scheduled: v.status === 'approved' && (v.effectiveFrom ?? '') > now,
          inEffect: inEffect.get(rule.id) === v.id,
          category: v.clause.category,
          categoryLabel: CATEGORY_LABELS[v.clause.category],
          requires: plainReading(v.clause),
          sourceText: v.sourceText,
          citation: v.clause.citation,
          clauseSha256: v.clauseSha256,
          smtLib2: v.clause.compiled.smtLib2Snippet,
          rego: v.clause.compiled.opaRegoRule,
          answers: v.answers,
          createdBy: names.get(v.createdBy)?.name ?? null,
          createdAt: v.createdAt,
          decidedBy: v.approvedBy ? names.get(v.approvedBy)?.name ?? null : null,
          decidedAt: v.approvedAt,
          effectiveFrom: v.effectiveFrom,
          note: v.decisionNote,
        }));
        const current = versions.find((v) => v.inEffect) ?? null;
        const latest = versions[versions.length - 1];
        return { id: rule.id, key: rule.key, title: rule.title, retiredAt: rule.retiredAt, current, latest, hasDraft: versions.some((v) => v.status === 'draft'), versions };
      })
    );
  });

  // ---------------------------------------------------------------- rule card

  r.post(
    '/workspaces/:workspaceId/rules/analyze',
    h.need('editRules'),
    h.handle(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) throw new StoreError('text is required');
      if (text.length > 20000) throw new StoreError('the clause is too long (max 20000 characters)');
      const category = req.body?.category;
      if (category !== undefined && category !== null && !isRuleCategory(category)) throw new StoreError(`category must be one of ${RULE_CATEGORIES.join(', ')}`);
      let values;
      try {
        values = validateClauseValues(req.body?.values);
      } catch (err) {
        throw new StoreError((err as Error).message);
      }
      res.json(await analyzeRule({ workspaceId: ws(req), text, category: (category ?? undefined) as RuleCategory | undefined, values }, { store, gov, ai }));
    })
  );

  // ---------------------------------------------------------------- exceptions, evidence and assistants

  /** Legal ends an approved exception early: { note }. The pull requests it covered are re-checked. */
  r.post(
    '/workspaces/:workspaceId/exceptions/:exceptionId/revoke',
    h.need('decideExceptions'),
    h.handle(async (req, res) => res.json(await revokeException(h.flows, { workspaceId: ws(req), exceptionId: String(req.params.exceptionId), userId: actor(res).id, note: String(req.body?.note ?? '') })))
  );
  /** Checks the whole chain on the server: signatures, order and hashes. The share page checks again in the browser. */
  r.get(
    '/workspaces/:workspaceId/evidence/verify',
    h.need('view'),
    h.handle(async (req, res) => {
      if (!evidence) return void res.json({ ok: true, count: 0, problems: [], keyIds: [], lastHeaderSha256: null, checkedAt: new Date().toISOString() });
      res.json(await evidence.verify(ws(req), await h.keysFor(ws(req))));
    })
  );
  /** What members' coding assistants did through the MCP endpoint (tool calls, newest first). */
  r.get('/workspaces/:workspaceId/assistant-calls', h.need('view'), (req, res) => res.json(gov.listMcpCalls(ws(req), Number(req.query.limit) || 50)));

  // ---------------------------------------------------------------- plan and usage

  r.get('/workspaces/:workspaceId/usage', h.need('view'), (req, res) => {
    const id = ws(req);
    const meta = gov.workspaceMeta(id);
    const plan = PLANS[meta.plan] ?? { label: meta.plan, seats: 0, repos: 0 };
    const settings = ai.settings(id);
    res.json({
      plan: meta.plan,
      planLabel: plan.label,
      seats: { used: store.listMembers(id).length, limit: plan.seats },
      repos: { used: store.listRepos(id).length, limit: plan.repos },
      ai: { mode: settings.mode, today: ai.tokensUsedToday(id), month: gov.tokensSince(id, startOfMonth()), dailyBudget: ai.effectiveBudget(id), callsMonth: gov.countSince('ai_calls', id, startOfMonth()) },
      assistantCalls: { today: gov.countSince('mcp_calls', id, startOfDay()), month: gov.countSince('mcp_calls', id, startOfMonth()) },
      evidenceRecords: evidence?.count(id) ?? 0,
      canManage: ['admin', 'owner'].includes(String(h.roleIn(req, res))),
    });
  });
}
