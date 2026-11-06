import express from 'express';
import type { Request, Response } from 'express';
import type { ProductStore, ShareRecord, StoredFinding } from '../product/store.js';
import type { EvidenceLog, EvidenceRecord, EvidenceTimestamp, PublicKeyEntry } from './log.js';
import { bodyInScope } from './records.js';
import { VERIFY_MJS } from './verifyScript.js';
import { buildZip } from './zip.js';

/**
 * What an auditor sees through a share link (product guide, Phase 5, items 4–5): a summary, the
 * history of the shared rules, checks over time, exceptions, and the signed evidence. No account
 * is needed. Code snippets are never included: they are the workspace's source code.
 */

export interface ShareView {
  workspace: { id: string; name: string };
  label: string | null;
  counterparty: string | null;
  period: { from: string; to: string };
  expiresAt: string;
  repos: string[];
  rules: Array<{
    key: string;
    title: string;
    versions: Array<{ version: number; status: string; text: string; citation: string; clauseSha256: string; approvedBy: string | null; approvedAt: string | null; effectiveFrom: string | null }>;
  }>;
  scans: Array<{
    id: string;
    at: string;
    repo: string;
    commit: string;
    pullRequest: number | null;
    trigger: string;
    conclusion: string | null;
    perRule: Array<{ ruleKey: string; newCount: number; existingCount: number; waivedCount: number }>;
    evidence: { seq: number; headerSha256: string } | null;
  }>;
  /** Findings of the latest scan of each repository's default branch, without code. */
  openFindings: Array<{ repo: string; commit: string; ruleKey: string; filePath: string; startLine: number; state: string; message: string; fingerprint: string }>;
  exceptions: Array<{ id: string; ruleKey: string; repo: string | null; where: string | null; pullRequest: number | null; reason: string; status: string; requestedBy: string | null; requestedAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; expiresAt: string | null }>;
  evidence: {
    /** Every header of the period, so the auditor can see nothing was removed. */
    headers: Array<{ seq: number; header: string; headerSha256: string; signature: string }>;
    /** Sequence numbers whose bodies are in this share. */
    bodySeqs: number[];
    /** Headers a Time-Stamp Authority (RFC 3161) vouched for; the tokens are in the pack. */
    timestamps?: Array<{ seq: number; headerSha256: string; tsaUrl: string; genTime: string }>;
  };
  keysUrl: string;
}

const userLabel = (store: ProductStore, id: string | null) => {
  if (!id) return null;
  if (id.startsWith('github:')) return `@${id.slice(7)} on GitHub`;
  const u = store.getUserById(id);
  return u?.name ?? u?.email ?? id;
};

/** The share's content, and the evidence records in its period with the bodies in its scope. */
export function buildShareView(store: ProductStore, log: EvidenceLog, share: ShareRecord, publicUrl: string): { view: ShareView; records: EvidenceRecord[]; bodies: EvidenceRecord[] } {
  const ws = share.workspaceId;
  const repos = store.reposForCounterparty(ws, share.counterpartyId);
  const repoIds = new Set(repos.map((r) => r.id));
  const ruleIds = new Set(share.ruleIds);
  const rules = share.ruleIds.map((id) => store.getRule(ws, id)).filter((r): r is NonNullable<typeof r> => !!r);
  const ruleKeys = new Set(rules.map((r) => r.key));

  const scans = store
    .scansInPeriod([...repoIds], share.periodFrom, share.periodTo)
    .filter((s) => s.ruleVersions.some((v) => ruleKeys.has(v.ruleKey)))
    .map((s) => ({
      id: s.id,
      at: s.finishedAt ?? s.createdAt,
      repo: s.repoFullName,
      commit: s.commitSha,
      pullRequest: s.prNumber,
      trigger: s.trigger,
      conclusion: s.conclusion,
      perRule: (s.summary?.perRule ?? []).filter((p) => ruleKeys.has(p.ruleKey)),
      evidence: store.scanEvidence(s.id),
    }));

  const openFindings: ShareView['openFindings'] = [];
  for (const repo of repos) {
    const latest = scans.filter((s) => s.repo === repo.fullName && s.pullRequest === null).at(-1);
    if (!latest) continue;
    for (const f of store.listFindings(latest.id).filter((x: StoredFinding) => ruleKeys.has(x.ruleKey))) {
      openFindings.push({ repo: repo.fullName, commit: latest.commit, ruleKey: f.ruleKey, filePath: f.filePath, startLine: f.startLine, state: f.state, message: f.message, fingerprint: f.fingerprint });
    }
  }

  const exceptions = store
    .listExceptions(ws)
    .filter((e) => ruleIds.has(e.ruleId) && (!e.repoId || repoIds.has(e.repoId)))
    .filter((e) => e.requestedAt <= share.periodTo && (e.status === 'requested' || (e.expiresAt ?? e.decidedAt ?? e.requestedAt) >= share.periodFrom))
    .map((e) => ({
      id: e.id,
      ruleKey: e.ruleKey,
      repo: e.repoName,
      where: e.filePath ? `${e.filePath}:${e.startLine ?? 1}` : e.pathGlob,
      pullRequest: e.prNumber,
      reason: e.reason,
      status: e.status,
      // Who asked: the label the request came with (a GitHub login, an assistant), else the person.
      requestedBy: e.requesterLabel ?? userLabel(store, e.requestedBy),
      requestedAt: e.requestedAt,
      decidedBy: userLabel(store, e.decidedBy),
      decidedAt: e.decidedAt,
      decisionNote: e.decisionNote,
      expiresAt: e.expiresAt,
    }));

  const records = log.records(ws, { from: share.periodFrom, to: share.periodTo });
  const bodies = records.filter((r) => bodyInScope(r.body, ruleIds, repoIds));
  const view: ShareView = {
    workspace: { id: ws, name: store.getWorkspace(ws)?.name ?? '' },
    label: share.label,
    counterparty: share.counterpartyName,
    period: { from: share.periodFrom, to: share.periodTo },
    expiresAt: share.expiresAt,
    repos: repos.map((r) => r.fullName),
    rules: rules.map((r) => ({
      key: r.key,
      title: r.title,
      versions: r.versions
        .filter((v) => (v.status === 'approved' || v.status === 'retired') && (v.approvedAt ?? '') <= share.periodTo)
        .map((v) => ({
          version: v.version,
          status: v.status,
          text: v.sourceText,
          citation: v.clause.citation,
          clauseSha256: v.clauseSha256,
          approvedBy: userLabel(store, v.approvedBy),
          approvedAt: v.approvedAt,
          effectiveFrom: v.effectiveFrom,
        })),
    })),
    scans,
    openFindings,
    exceptions,
    evidence: {
      headers: records.map((r) => ({ seq: r.seq, header: r.header, headerSha256: r.headerSha256, signature: r.signature })),
      bodySeqs: bodies.map((r) => r.seq),
      timestamps: log
        .timestamps(ws)
        .filter((t) => records.some((r) => r.seq === t.seq && r.headerSha256 === t.headerSha256))
        .map(({ seq, headerSha256, tsaUrl, genTime }) => ({ seq, headerSha256, tsaUrl, genTime })),
    },
    keysUrl: `${publicUrl}/.well-known/lexcompiler/${ws}/keys.json`,
  };
  return { view, records, bodies };
}

/** SARIF 2.1.0 of the latest default-branch findings per repository (no snippets). */
function sarifFor(view: ShareView, repo: string): Record<string, unknown> {
  const findings = view.openFindings.filter((f) => f.repo === repo);
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'LexCompiler', informationUri: 'https://github.com/MRSHAKILS/LexCompiler', rules: view.rules.map((r) => ({ id: r.key, name: r.title, shortDescription: { text: r.title } })) } },
        versionControlProvenance: findings[0] ? [{ repositoryUri: repo, revisionId: findings[0].commit }] : [],
        results: findings.map((f) => ({
          ruleId: f.ruleKey,
          level: f.state === 'waived' ? 'note' : 'error',
          message: { text: f.message },
          partialFingerprints: { lexcompiler: f.fingerprint },
          ...(f.state === 'waived' ? { suppressions: [{ kind: 'external', justification: 'Waived by an approved exception' }] } : {}),
          locations: [{ physicalLocation: { artifactLocation: { uri: f.filePath }, region: { startLine: f.startLine } } }],
        })),
      },
    ],
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/** A printable summary of the share (report.html in the pack). */
export function renderReportHtml(view: ShareView): string {
  const first = view.evidence.headers[0];
  const last = view.evidence.headers.at(-1);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Compliance evidence: ${esc(view.workspace.name)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border:1px solid #bbb;padding:.3rem .5rem;text-align:left;vertical-align:top}th{background:#eee}code{font-size:12px;word-break:break-all}blockquote{margin:.3rem 0;padding-left:.8rem;border-left:3px solid #999}</style>
</head><body>
<h1>Compliance evidence: ${esc(view.workspace.name)}</h1>
<p>${view.counterparty ? `For ${esc(view.counterparty)}. ` : ''}Period ${day(view.period.from)} to ${day(view.period.to)}. Repositories: ${esc(view.repos.join(', ') || 'none')}.</p>
<p>Evidence records #${first?.seq ?? '—'} to #${last?.seq ?? '—'} (${view.evidence.headers.length} signed headers, ${view.evidence.bodySeqs.length} bodies in this pack${view.evidence.timestamps?.length ? `; ${view.evidence.timestamps.length} timestamped by a Time-Stamp Authority` : ''}). Check them with <code>node verify.mjs . keys.json</code>, using keys.json from ${esc(view.workspace.name)}'s own website.</p>
<h2>Rules</h2>
${view.rules
  .map(
    (r) => `<h3>${esc(r.key)}: ${esc(r.title)}</h3><table><tr><th>Version</th><th>Approved</th><th>Effective</th><th>Text</th></tr>${r.versions
      .map((v) => `<tr><td>v${v.version} (${esc(v.status)})</td><td>${esc(v.approvedBy)} · ${day(v.approvedAt)}</td><td>${day(v.effectiveFrom ?? v.approvedAt)}</td><td><blockquote>${esc(v.text)}</blockquote><small>${esc(v.citation)} · clause SHA-256 <code>${esc(v.clauseSha256)}</code></small></td></tr>`)
      .join('')}</table>`
  )
  .join('\n')}
<h2>Checks</h2>
<table><tr><th>When</th><th>Repository</th><th>Commit</th><th>Pull request</th><th>Result</th><th>Findings (new / existing / waived)</th><th>Evidence</th></tr>
${view.scans
  .map(
    (s) =>
      `<tr><td>${esc(s.at.replace('T', ' ').slice(0, 16))}</td><td>${esc(s.repo)}</td><td><code>${esc(s.commit.slice(0, 12))}</code></td><td>${s.pullRequest ?? '—'}</td><td>${esc(s.conclusion)}</td><td>${s.perRule
        .map((p) => `${esc(p.ruleKey)}: ${p.newCount} / ${p.existingCount} / ${p.waivedCount}`)
        .join('<br>')}</td><td>${s.evidence ? `#${s.evidence.seq} <code>${esc(s.evidence.headerSha256.slice(0, 16))}…</code>` : '—'}</td></tr>`
  )
  .join('\n')}</table>
<h2>Exceptions</h2>
${view.exceptions.length === 0 ? '<p>None.</p>' : `<table><tr><th>Rule</th><th>Where</th><th>Reason</th><th>Decision</th><th>Until</th></tr>${view.exceptions
  .map((e) => `<tr><td>${esc(e.ruleKey)}</td><td>${esc(e.repo)} ${esc(e.where)}</td><td>${esc(e.reason)}</td><td>${esc(e.status)}${e.decidedBy ? ` by ${esc(e.decidedBy)} on ${day(e.decidedAt)}: ${esc(e.decisionNote)}` : ''}</td><td>${day(e.expiresAt)}</td></tr>`)
  .join('')}</table>`}
</body></html>
`;
}

/** The evidence pack: signed headers, bodies in scope, rules, exceptions, SARIF, keys, verify.mjs and report.html. */
export function buildEvidencePack(view: ShareView, records: EvidenceRecord[], bodies: EvidenceRecord[], keys: PublicKeyEntry[], timestamps: EvidenceTimestamp[] = []): Buffer {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamped = timestamps.filter((t) => records.some((r) => r.seq === t.seq && r.headerSha256 === t.headerSha256));
  const files: Array<{ name: string; data: string | Buffer }> = [
    {
      name: 'README.txt',
      data: [
        `Compliance evidence for ${view.workspace.name}${view.counterparty ? `, shared with ${view.counterparty}` : ''}.`,
        `Period: ${view.period.from} to ${view.period.to}.`,
        '',
        'headers.jsonl  every signed evidence header of the period, in order (header = the exact signed text)',
        'bodies.jsonl   the record bodies about the shared rules and repositories',
        'rules/         each shared rule with its approved versions',
        'exceptions.json, sarif/, report.html (printable summary)',
        'keys.json      the public keys LexCompiler served with this pack',
        '',
        'To check the pack, take keys.json from the company\'s own website (not from this pack) and run:',
        '  node verify.mjs . keys-from-their-website.json',
        'It prints OK when every header is signed, none is missing between the first and the last, and every body matches its header.',
        '',
        ...(stamped.length
          ? [
              'timestamps/    RFC 3161 tokens from a Time-Stamp Authority over some headers (<seq>.tsr) and those headers\' exact text (<seq>.header).',
              '               verify.mjs checks each .header matches headers.jsonl. Check a token with OpenSSL and the TSA\'s CA certificate:',
              '  openssl ts -verify -token_in -in timestamps/<seq>.tsr -data timestamps/<seq>.header -CAfile <the TSA CA certificate>',
              `TSA: ${[...new Set(stamped.map((t) => t.tsaUrl))].join(', ')}`,
              '',
            ]
          : []),
      ].join('\n'),
    },
    ...stamped.flatMap((t) => [
      { name: `timestamps/${t.seq}.tsr`, data: Buffer.from(t.tokenBase64, 'base64') },
      { name: `timestamps/${t.seq}.header`, data: records.find((r) => r.seq === t.seq)!.header },
    ]),
    { name: 'headers.jsonl', data: records.map((r) => JSON.stringify({ seq: r.seq, header: r.header, signature: r.signature })).join('\n') + '\n' },
    { name: 'bodies.jsonl', data: bodies.map((r) => JSON.stringify({ seq: r.seq, body: r.body })).join('\n') + (bodies.length ? '\n' : '') },
    ...view.rules.map((r) => ({ name: `rules/${slug(r.key)}.json`, data: JSON.stringify(r, null, 2) + '\n' })),
    { name: 'exceptions.json', data: JSON.stringify(view.exceptions, null, 2) + '\n' },
    ...[...new Set(view.openFindings.map((f) => f.repo))].map((repo) => ({ name: `sarif/${slug(repo)}.sarif.json`, data: JSON.stringify(sarifFor(view, repo), null, 2) + '\n' })),
    { name: 'keys.json', data: JSON.stringify(keys, null, 2) + '\n' },
    { name: 'verify.mjs', data: VERIFY_MJS },
    { name: 'report.html', data: renderReportHtml(view) },
  ];
  return buildZip(files);
}

export interface PublicEvidenceOptions {
  store: ProductStore;
  log: EvidenceLog;
  /** The workspace's public keys (every key that signed its records). */
  keysFor: (workspaceId: string) => Promise<PublicKeyEntry[]>;
  publicUrl: string;
}

/**
 * Public routes, outside the API guard: the share page's data and pack, and the public keys.
 * Mount at the app root.
 */
export function createPublicEvidenceRouter(options: PublicEvidenceOptions) {
  const r = express.Router();
  const { store, log } = options;
  const open = (req: Request, res: Response): ShareRecord | null => {
    // The token is in the URL: keep it out of caches and referrers.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const share = store.shareByToken(String(req.params.token));
    if (!share) {
      res.status(404).json({ error: 'This link is not valid: it was revoked, it expired, or it is wrong.' });
      return null;
    }
    store.recordShareView(share.id, req.ip ?? null, req.get('user-agent') ?? null);
    return share;
  };

  r.get('/api/share/:token', (req, res) => {
    const share = open(req, res);
    if (share) res.json(buildShareView(store, log, share, options.publicUrl).view);
  });
  r.get('/api/share/:token/pack.zip', async (req, res) => {
    const share = open(req, res);
    if (!share) return;
    try {
      const { view, records, bodies } = buildShareView(store, log, share, options.publicUrl);
      const zip = buildEvidencePack(view, records, bodies, await options.keysFor(share.workspaceId), log.timestamps(share.workspaceId));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="lexcompiler-evidence-${share.periodFrom.slice(0, 10)}-${share.periodTo.slice(0, 10)}.zip"`);
      res.send(zip);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  r.get('/.well-known/lexcompiler/:workspaceId/keys.json', async (req, res) => {
    const id = String(req.params.workspaceId);
    if (!store.getWorkspace(id)) return void res.status(404).json({ error: 'unknown workspace' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await options.keysFor(id));
  });
  return r;
}
