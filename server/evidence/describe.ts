import type { EvidenceHeader } from './log.js';

/**
 * One line per evidence record, for the Overview activity feed, the evidence list and the public
 * share page. Reads both body shapes: the recorder's camelCase bodies (`ruleKey`, `approvedBy:
 * {name}`, `pullRequest`, `results`, `scanId`) and the snake_case bodies the product dashboard
 * wrote before the merge (`rule`, `decided_by`, `pr`, `counts`, `scan`). A record whose body is
 * not given (not in a share's scope) is described from its header only.
 */
export interface EvidenceDescription {
  kind: string;
  text: string;
  link: string | null;
}

type Body = Record<string, unknown>;

/** A person in a body: a plain name (old bodies) or `{ name, email, userId }` (recorder bodies). */
function person(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const p = v as { name?: unknown; email?: unknown; userId?: unknown };
      if (typeof p.name === 'string' && p.name) return p.name;
      if (typeof p.email === 'string' && p.email) return p.email;
      if (typeof p.userId === 'string' && p.userId) return p.userId;
    }
  }
  return 'Someone';
}

const str = (v: unknown) => (v == null ? '' : String(v));
const first = (b: Body, ...keys: string[]) => {
  for (const k of keys) if (b[k] != null && b[k] !== '') return b[k];
  return null;
};

/** New, existing and waived counts: `counts` (old bodies) or the per-rule `results` lists. */
function counts(b: Body): { new: number; existing: number; waived: number } {
  const c = b.counts as { new?: number; existing?: number; waived?: number } | null | undefined;
  if (c && typeof c === 'object') return { new: Number(c.new ?? 0), existing: Number(c.existing ?? 0), waived: Number(c.waived ?? 0) };
  const results = Array.isArray(b.results) ? (b.results as Array<{ new?: unknown[]; existing?: unknown[]; waived?: unknown[] }>) : [];
  const sum = (k: 'new' | 'existing' | 'waived') => results.reduce((n, r) => n + (Array.isArray(r[k]) ? r[k]!.length : 0), 0);
  return { new: sum('new'), existing: sum('existing'), waived: sum('waived') };
}

function location(b: Body): string {
  const loc = first(b, 'location');
  if (loc) return str(loc);
  if (b.filePath) return `${str(b.filePath)}:${str(b.startLine ?? 1)}`;
  if (b.pathGlob) return str(b.pathGlob);
  return 'an unspecified place';
}

export function describeEvidence(e: { header: Pick<EvidenceHeader, 'type'> & Partial<EvidenceHeader>; body?: Body | null }): EvidenceDescription {
  const type = String(e.header.type);
  if (!e.body) return { kind: 'withheld', text: `${type} (details not in this share)`, link: null };
  const b = e.body;
  const rule = str(first(b, 'ruleKey', 'rule'));
  const version = str(first(b, 'version'));
  switch (type) {
    case 'rule.approved':
      return { kind: 'rule', text: `${person(b.approvedBy, b.decided_by)} approved ${rule} v${version}: ${str(b.title)}`, link: '/app/rules' };
    case 'rule.rejected':
      return { kind: 'rule', text: `${person(b.rejectedBy, b.decided_by)} rejected a draft of ${rule}`, link: '/app/rules' };
    case 'rule.retired':
      return { kind: 'rule', text: `${person(b.retiredBy, b.decided_by)} retired ${rule}`, link: '/app/rules' };
    case 'rule.rescheduled':
      return { kind: 'rule', text: `${person(b.changedBy)} moved the start of ${rule} v${version} to ${str(b.effectiveFrom).slice(0, 10)}`, link: '/app/rules' };
    case 'scan.completed': {
      const c = counts(b);
      const scanId = str(first(b, 'scanId', 'scan'));
      const link = scanId ? `/app/checks/${scanId}` : null;
      const pr = first(b, 'pullRequest', 'pr');
      if (pr) {
        const failed = str(b.conclusion) === 'failure';
        return { kind: failed ? 'check-failed' : 'check-passed', text: `Check ${failed ? 'failed' : 'passed'} on pull request #${str(pr)} in ${str(b.repo)}: ${c.new} new, ${c.waived} waived`, link };
      }
      return { kind: 'scan', text: `Scanned ${str(b.repo)} @ ${str(b.commit).slice(0, 7)}: ${c.existing + c.new} open finding(s)`, link };
    }
    case 'exception.requested':
      return { kind: 'exception', text: `${person(b.requesterLabel, b.requested_by, b.requestedBy)} asked for an exception to ${rule} at ${location(b)}`, link: '/app/exceptions' };
    case 'exception.approved':
      return { kind: 'exception-approved', text: `${person(b.decidedBy, b.decided_by)} approved an exception to ${rule} until ${str(first(b, 'expiresAt', 'expires_at')).slice(0, 10)}`, link: '/app/exceptions' };
    case 'exception.rejected':
      return { kind: 'exception', text: `${person(b.decidedBy, b.decided_by)} rejected an exception to ${rule}`, link: '/app/exceptions' };
    case 'exception.revoked':
      return { kind: 'exception', text: `${person(b.revokedBy, b.revoked_by, b.decidedBy)} revoked an exception to ${rule}`, link: '/app/exceptions' };
    case 'exception.expired':
      return { kind: 'exception', text: `An exception to ${rule} expired`, link: '/app/exceptions' };
    case 'share.created':
      return { kind: 'share', text: `${person(b.createdBy, b.created_by)} shared evidence: "${str(b.label)}"`, link: '/app/evidence' };
    case 'share.revoked':
      return { kind: 'share', text: `${person(b.revokedBy, b.revoked_by)} revoked the share link "${str(b.label)}"`, link: '/app/evidence' };
    default:
      return { kind: 'other', text: type, link: null };
  }
}
