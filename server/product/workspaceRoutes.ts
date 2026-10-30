import express from 'express';
import type { Request, Response } from 'express';
import type { AiGateway } from '../ai/gateway.js';
import { OidcProvider } from '../auth/oidc.js';
import { RateLimiter, verifyPassword } from '../auth/passwords.js';
import type { EvidenceEntry, EvidenceLog } from '../evidence/log.js';
import type { RuleCategory } from '../../shared/types.js';
import { isRuleCategory, RULE_CATEGORIES, validateClauseValues } from './clauses.js';
import { decideException, requestExceptions, revokeException, type FlowDeps } from './flows.js';
import type { ExceptionStatus, GovernanceStore } from './governance.js';
import { analyzeRule, CATEGORY_LABELS, plainReading } from './ruleCard.js';
import type { RouteHelpers } from './router.js';
import { StoreError, type ProductStore } from './store.js';

/**
 * Workspace routes for the web app: sign-in with a password, the overview, the rule card,
 * exceptions, evidence, share links, assistant tokens and usage. Mounted inside the product
 * router, so the same role checks apply.
 */
export interface WorkspaceRouteDeps {
  store: ProductStore;
  gov: GovernanceStore;
  evidence: EvidenceLog;
  ai: AiGateway;
  flows: FlowDeps;
  publicUrl: string;
  passwordSignIn: boolean;
  /** Secure cookies when the public URL is https. */
  secureCookies: boolean;
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

/** One line per evidence record, for the activity feed. */
export function describeEvidence(e: EvidenceEntry): { kind: string; text: string; link: string | null } {
  const b = e.body as Record<string, unknown> & { counts?: { new?: number; existing?: number; waived?: number } | null };
  const s = (k: string) => (b[k] == null ? '' : String(b[k]));
  switch (e.header.type) {
    case 'rule.approved':
      return { kind: 'rule', text: `${s('decided_by')} approved ${s('rule')} v${s('version')}: ${s('title')}`, link: '/app/rules' };
    case 'rule.rejected':
      return { kind: 'rule', text: `${s('decided_by')} rejected a draft of ${s('rule')}`, link: '/app/rules' };
    case 'rule.retired':
      return { kind: 'rule', text: `${s('decided_by')} retired ${s('rule')}`, link: '/app/rules' };
    case 'scan.completed': {
      const c = b.counts ?? {};
      if (b.pr) {
        const failed = s('conclusion') === 'failure';
        return { kind: failed ? 'check-failed' : 'check-passed', text: `Check ${failed ? 'failed' : 'passed'} on pull request #${s('pr')} in ${s('repo')}: ${c.new ?? 0} new, ${c.waived ?? 0} waived`, link: `/app/checks/${s('scan')}` };
      }
      return { kind: 'scan', text: `Scanned ${s('repo')} @ ${s('commit').slice(0, 7)}: ${(c.existing ?? 0) + (c.new ?? 0)} open finding(s)`, link: `/app/checks/${s('scan')}` };
    }
    case 'exception.requested':
      return { kind: 'exception', text: `${s('requested_by')} asked for an exception to ${s('rule')} at ${s('location')}`, link: '/app/exceptions' };
    case 'exception.approved':
      return { kind: 'exception-approved', text: `${s('decided_by')} approved an exception to ${s('rule')} until ${s('expires_at').slice(0, 10)}`, link: '/app/exceptions' };
    case 'exception.rejected':
      return { kind: 'exception', text: `${s('decided_by')} rejected an exception to ${s('rule')}`, link: '/app/exceptions' };
    case 'exception.revoked':
      return { kind: 'exception', text: `${s('revoked_by')} revoked an exception to ${s('rule')}`, link: '/app/exceptions' };
    case 'exception.expired':
      return { kind: 'exception', text: `An exception to ${s('rule')} expired`, link: '/app/exceptions' };
    case 'share.created':
      return { kind: 'share', text: `${s('created_by')} shared evidence: "${s('label')}"`, link: '/app/evidence' };
    case 'share.revoked':
      return { kind: 'share', text: `${s('revoked_by')} revoked the share link "${s('label')}"`, link: '/app/evidence' };
    default:
      return { kind: 'other', text: e.header.type, link: null };
  }
}

export function mountWorkspaceRoutes(r: express.Router, h: RouteHelpers, deps: WorkspaceRouteDeps): void {
  const { store, gov, evidence, ai } = deps;
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const cookie = (value: string, maxAgeS: number) => `lexc_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${deps.secureCookies ? '; Secure' : ''}`;

  // ---------------------------------------------------------------- password sign-in

  if (deps.passwordSignIn) {
    r.post('/auth/password', async (req: Request, res: Response) => {
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
      const evidenceTail = evidence.list(id, { latest: 30 }).reverse();
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
          evidenceRecords: evidence.count(id),
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

  // ---------------------------------------------------------------- exceptions

  r.get('/workspaces/:workspaceId/exceptions', h.need('view'), (req, res) => {
    const status = typeof req.query.status === 'string' ? (req.query.status.split(',') as ExceptionStatus[]) : undefined;
    res.json(gov.listExceptions(ws(req), status));
  });
  r.post(
    '/workspaces/:workspaceId/exceptions',
    h.need('requestExceptions'),
    h.handle((req, res) => {
      const scan = store.getScan(ws(req), String(req.body?.scanId ?? ''));
      if (!scan) throw new StoreError('scan not found', 404);
      const ids = new Set((Array.isArray(req.body?.findingIds) ? req.body.findingIds : []).map(String));
      const findings = store.listFindings(scan.id).filter((f) => ids.has(f.id) && f.state !== 'waived');
      if (findings.length === 0) throw new StoreError('choose at least one finding that is not already waived');
      const user = actor(res);
      const records = requestExceptions(deps.flows, {
        workspaceId: ws(req),
        findings: findings.map((f) => ({ ruleId: f.ruleId, ruleKey: f.ruleKey, repoId: scan.repoId, fingerprint: f.fingerprint, filePath: f.filePath, startLine: f.startLine, message: f.message, scanId: scan.id, prNumber: scan.prNumber })),
        reason: String(req.body?.reason ?? ''),
        requestedBy: user.id,
        requesterLabel: user.name ?? user.email ?? 'A member',
        via: 'dashboard',
      });
      res.status(201).json(records);
    })
  );
  const decide = (decision: 'approved' | 'rejected') =>
    h.handle((req, res) => {
      res.json(decideException(deps.flows, { workspaceId: ws(req), exceptionId: String(req.params.exceptionId), decision, userId: actor(res).id, note: String(req.body?.note ?? ''), expiresAt: req.body?.expiresAt ? String(req.body.expiresAt) : null }));
    });
  r.post('/workspaces/:workspaceId/exceptions/:exceptionId/approve', h.need('decideExceptions'), decide('approved'));
  r.post('/workspaces/:workspaceId/exceptions/:exceptionId/reject', h.need('decideExceptions'), decide('rejected'));
  r.post(
    '/workspaces/:workspaceId/exceptions/:exceptionId/revoke',
    h.need('decideExceptions'),
    h.handle((req, res) => res.json(revokeException(deps.flows, { workspaceId: ws(req), exceptionId: String(req.params.exceptionId), userId: actor(res).id, note: String(req.body?.note ?? '') })))
  );

  // ---------------------------------------------------------------- evidence and share links

  r.get('/workspaces/:workspaceId/evidence', h.need('view'), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const entries = evidence.list(ws(req), { latest: limit }).reverse();
    res.json({ count: evidence.count(ws(req)), keys: evidence.publicKeys(), entries: entries.map((e) => ({ seq: e.seq, header: e.header, headerJson: e.headerJson, headerSha256: e.headerSha256, signature: e.signature, body: e.body, bodyJson: e.bodyJson, ...describeEvidence(e) })) });
  });
  r.get('/workspaces/:workspaceId/evidence/verify', h.need('view'), (req, res) => res.json(evidence.verify(ws(req))));

  r.get('/workspaces/:workspaceId/shares', h.need('createShares'), (req, res) => res.json(gov.listShares(ws(req))));
  r.post(
    '/workspaces/:workspaceId/shares',
    h.need('createShares'),
    h.handle((req, res) => {
      const user = actor(res);
      const { token, record } = gov.createShare({
        workspaceId: ws(req),
        label: String(req.body?.label ?? ''),
        periodFrom: String(req.body?.periodFrom ?? ''),
        periodTo: String(req.body?.periodTo ?? ''),
        expiresAt: String(req.body?.expiresAt ?? ''),
        createdBy: user.id,
      });
      evidence.append(ws(req), 'share.created', { share: record.id, label: record.label, period_from: record.periodFrom, period_to: record.periodTo, expires_at: record.expiresAt, created_by: user.name ?? user.email });
      res.status(201).json({ ...record, url: `${deps.publicUrl}/share/${token}` });
    })
  );
  r.post(
    '/workspaces/:workspaceId/shares/:shareId/revoke',
    h.need('createShares'),
    h.handle((req, res) => {
      const record = gov.revokeShare(ws(req), String(req.params.shareId));
      const user = actor(res);
      evidence.append(ws(req), 'share.revoked', { share: record.id, label: record.label, revoked_by: user.name ?? user.email });
      res.json(record);
    })
  );
  r.get('/workspaces/:workspaceId/shares/:shareId/views', h.need('createShares'), (req, res) => {
    if (!gov.getShare(ws(req), String(req.params.shareId))) return void res.status(404).json({ error: 'share link not found' });
    res.json(gov.listShareViews(String(req.params.shareId)));
  });

  // ---------------------------------------------------------------- coding-assistant tokens

  const ownerView = (req: Request, res: Response) => {
    const role = h.roleIn(req, res);
    return role === 'admin' || role === 'owner';
  };
  r.get('/workspaces/:workspaceId/tokens', h.need('view'), (req, res) => {
    const all = ownerView(req, res) && req.query.all === '1';
    res.json(gov.listTokens(ws(req), all ? null : actor(res).id));
  });
  r.post(
    '/workspaces/:workspaceId/tokens',
    h.need('view'),
    h.handle((req, res) => {
      const days = Number(req.body?.days ?? 30);
      const { token, record } = gov.createToken({ workspaceId: ws(req), userId: actor(res).id, name: String(req.body?.name ?? ''), days });
      res.status(201).json({ ...record, token, mcpUrl: `${deps.publicUrl}/mcp` });
    })
  );
  r.post(
    '/workspaces/:workspaceId/tokens/:tokenId/revoke',
    h.need('view'),
    h.handle((req, res) => res.json(gov.revokeToken(ws(req), String(req.params.tokenId), { userId: actor(res).id, canRevokeOthers: ownerView(req, res) })))
  );
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
      evidenceRecords: evidence.count(id),
      canManage: ['admin', 'owner'].includes(String(h.roleIn(req, res))),
    });
  });
}
