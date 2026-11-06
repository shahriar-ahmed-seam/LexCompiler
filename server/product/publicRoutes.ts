import express from 'express';
import { RateLimiter } from '../auth/passwords.js';
import { describeEvidence } from '../evidence/describe.js';
import type { EvidenceLog, PublicKeyEntry } from '../evidence/log.js';
import { verifyEntries } from '../evidence/log.js';
import { buildShareView } from '../evidence/share.js';
import { CATEGORY_LABELS, plainReading } from './ruleCard.js';
import type { ProductStore } from './store.js';

/**
 * The share page's data in the shape the web app reads (`/api/public/share/:token`): the same
 * content as `/api/share/:token` (evidence/share.ts, `buildShareView`), so what an auditor sees is
 * scoped the same way, with one plain line per signed record and the server's own verification.
 * The signing keys are published by evidence/share.ts (`keys.json`). Registered before the API
 * guard; the share token is the only credential.
 */
export function createPublicRoutes(deps: { store: ProductStore; log: EvidenceLog; keysFor: (workspaceId: string) => Promise<PublicKeyEntry[]>; publicUrl: string }) {
  const r = express.Router();
  const limiter = new RateLimiter(120, 60_000);
  const { store, log } = deps;

  r.get('/api/public/share/:token', async (req, res) => {
    // The token is in the URL: keep it out of caches and referrers.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!limiter.take(ip)) return void res.status(429).json({ error: 'Too many requests.' });
    try {
      const share = store.shareByToken(String(req.params.token));
      if (!share) return void res.status(404).json({ error: 'This link has expired, was revoked, or never existed.' });
      store.recordShareView(share.id, ip, req.header('user-agent') ?? null);
      const { view, records, bodies } = buildShareView(store, log, share, deps.publicUrl);
      const withBody = new Set(bodies.map((b) => b.seq));
      const keys = await deps.keysFor(share.workspaceId);

      const ruleByKey = new Map(share.ruleIds.map((id) => store.getRule(share.workspaceId, id)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => [x.key, x]));
      const rules = view.rules.map((vr) => {
        const rule = ruleByKey.get(vr.key)!;
        return {
          key: vr.key,
          title: vr.title,
          retiredAt: rule.retiredAt,
          versions: vr.versions.map((v) => {
            const full = rule.versions.find((x) => x.version === v.version)!;
            return {
              version: v.version,
              status: v.status,
              category: CATEGORY_LABELS[full.clause.category],
              requires: plainReading(full.clause),
              sourceText: v.text,
              clauseSha256: v.clauseSha256,
              decidedBy: v.approvedBy,
              decidedAt: v.approvedAt,
              effectiveFrom: v.effectiveFrom,
            };
          }),
        };
      });
      const exceptions = view.exceptions.map((e) => ({
        rule: e.ruleKey,
        repo: e.repo,
        location: e.where,
        pr: e.pullRequest,
        reason: e.reason,
        requestedBy: e.requestedBy,
        requestedAt: e.requestedAt,
        status: e.status,
        decidedBy: e.decidedBy,
        decidedAt: e.decidedAt,
        note: e.decisionNote,
        expiresAt: e.expiresAt,
      }));
      // Every record of the period, signed: the auditor can check that none is missing or changed.
      // A body outside the share's rules and repositories is withheld; its header is still checked.
      const signed = records.map((rec) => {
        const header = JSON.parse(rec.header) as Parameters<typeof describeEvidence>[0]['header'];
        const bodyJson = withBody.has(rec.seq) ? rec.body : undefined;
        return { seq: rec.seq, headerJson: rec.header, headerSha256: rec.headerSha256, signature: rec.signature, ...(bodyJson === undefined ? {} : { bodyJson }), ...describeEvidence({ header, body: bodyJson === undefined ? undefined : JSON.parse(bodyJson) }) };
      });
      res.json({
        share: { label: share.label, periodFrom: share.periodFrom, periodTo: share.periodTo, expiresAt: share.expiresAt, createdAt: share.createdAt, createdBy: share.createdByName },
        workspace: view.workspace,
        generatedAt: new Date().toISOString(),
        rules,
        exceptions,
        keys,
        keysUrl: `/.well-known/lexcompiler/${share.workspaceId}/keys.json`,
        packUrl: `/api/share/${encodeURIComponent(String(req.params.token))}/pack.zip`,
        records: signed,
        verification: verifyEntries(signed, keys),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return r;
}
