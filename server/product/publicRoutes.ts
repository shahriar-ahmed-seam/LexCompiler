import express from 'express';
import { RateLimiter } from '../auth/passwords.js';
import type { EvidenceLog } from '../evidence/log.js';
import { verifyEntries } from '../evidence/log.js';
import type { GovernanceStore } from './governance.js';
import { CATEGORY_LABELS, plainReading } from './ruleCard.js';
import type { ProductStore } from './store.js';
import { describeEvidence } from './workspaceRoutes.js';

/**
 * Pages an auditor opens without an account: a share link's data, and each workspace's public
 * signing keys. Registered before the API guard; the share token is the only credential.
 */
export function createPublicRoutes(deps: { store: ProductStore; gov: GovernanceStore; evidence: EvidenceLog }) {
  const r = express.Router();
  const limiter = new RateLimiter(120, 60_000);
  const { store, gov, evidence } = deps;

  r.get('/.well-known/lexcompiler/:workspaceId/keys.json', (req, res) => {
    if (!store.getWorkspace(String(req.params.workspaceId))) return void res.status(404).json({ error: 'workspace not found' });
    res.set('Cache-Control', 'public, max-age=300').json(evidence.publicKeys());
  });

  r.get('/api/public/share/:token', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!limiter.take(ip)) return void res.status(429).json({ error: 'Too many requests.' });
    const share = gov.shareByToken(String(req.params.token));
    if (!share) return void res.status(404).json({ error: 'This link has expired, was revoked, or never existed.' });
    gov.logShareView(share.id, ip, req.header('user-agent') ?? null);
    const workspace = store.getWorkspace(share.workspaceId)!;
    const to = share.periodTo.slice(0, 10) === share.periodFrom.slice(0, 10) ? `${share.periodTo.slice(0, 10)}T23:59:59.999Z` : share.periodTo;
    const entries = evidence.list(share.workspaceId, { from: share.periodFrom, to });
    const keys = evidence.publicKeys();
    const people = (ids: Array<string | null>) => gov.people(ids.filter((x): x is string => Boolean(x)));
    const rules = store.listRules(share.workspaceId).map((rule) => {
      const names = people(rule.versions.map((v) => v.approvedBy));
      return {
        key: rule.key,
        title: rule.title,
        retiredAt: rule.retiredAt,
        versions: rule.versions
          .filter((v) => v.status !== 'draft')
          .map((v) => ({
            version: v.version,
            status: v.status,
            category: CATEGORY_LABELS[v.clause.category],
            requires: plainReading(v.clause),
            sourceText: v.sourceText,
            clauseSha256: v.clauseSha256,
            decidedBy: v.approvedBy ? names.get(v.approvedBy)?.name ?? null : null,
            decidedAt: v.approvedAt,
            effectiveFrom: v.effectiveFrom,
          })),
      };
    });
    const exceptions = gov.listExceptions(share.workspaceId).map((e) => ({
      rule: e.ruleKey,
      repo: e.repoFullName,
      location: e.filePath ? `${e.filePath}:${e.startLine}` : null,
      pr: e.prNumber,
      reason: e.reason,
      requestedBy: e.requesterLabel,
      requestedAt: e.requestedAt,
      status: e.status,
      decidedBy: e.decidedByName,
      decidedAt: e.decidedAt,
      note: e.decisionNote,
      expiresAt: e.expiresAt,
    }));
    res.set('Cache-Control', 'no-store').json({
      share: { label: share.label, periodFrom: share.periodFrom, periodTo: share.periodTo, expiresAt: share.expiresAt, createdAt: share.createdAt, createdBy: share.createdByName },
      workspace: { id: workspace.id, name: workspace.name },
      generatedAt: new Date().toISOString(),
      rules,
      exceptions,
      keys,
      keysUrl: `/.well-known/lexcompiler/${workspace.id}/keys.json`,
      // Every record of the period, signed: the auditor can check that none is missing or changed.
      records: entries.map((e) => ({ seq: e.seq, headerJson: e.headerJson, headerSha256: e.headerSha256, signature: e.signature, bodyJson: e.bodyJson, ...describeEvidence(e) })),
      verification: verifyEntries(entries, keys),
    });
  });

  return r;
}
