import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { keyIdFor, type AttestationSigner } from './enterprise/attestationSigner.js';
import { describeEvidence } from './evidence/describe.js';
import { EvidenceLog, toEntry, verifyEntries, verifyRecords } from './evidence/log.js';
import { bodyInScope, EvidenceRecorder } from './evidence/records.js';
import type { ExceptionRecord, Rule, RuleVersion, ShareRecord } from './product/store.js';
import { ProductStore } from './product/store.js';

function edSigner(): AttestationSigner {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { keyId: keyIdFor(publicKeyPem), algorithm: 'Ed25519', publicKeyPem, backend: 'test', sign: async (d) => crypto.sign(null, d, privateKey) };
}

function ecSigner(): AttestationSigner {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { keyId: keyIdFor(publicKeyPem), algorithm: 'ECDSA_P256_SHA256', publicKeyPem, backend: 'test', sign: async (d) => crypto.sign('sha256', d, { key: privateKey, dsaEncoding: 'der' }) };
}

function setup(signer = edSigner()) {
  const db = openDatabase(':memory:');
  const store = new ProductStore(db);
  const user = store.upsertUser({ sub: 'nusrat', email: 'nusrat@example.com', name: 'Nusrat Jahan' });
  const ws = store.createWorkspace('W', user.id).id;
  const log = new EvidenceLog(db, async () => signer);
  return { db, store, user, ws, log, recorder: new EvidenceRecorder(log, store), signer };
}

describe('evidence log compatibility API (EvidenceEntry, ChainCheck)', () => {
  it('lists, counts and verifies a chain through the Shakil engine', async () => {
    const { ws, log } = setup();
    for (const n of [1, 2, 3, 4]) await log.append(ws, 'rule.retired', { ruleIds: [`r${n}`], repoIds: [], ruleKey: `R-${n}` });
    expect(log.count(ws)).toBe(4);
    const entries = log.list(ws);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(entries[1].header).toMatchObject({ seq: 2, type: 'rule.retired', prev: entries[0].headerSha256 });
    expect(entries[1].headerJson).toBe(log.records(ws)[1].header);
    expect(entries[1].body).toMatchObject({ ruleKey: 'R-2' });
    expect(log.list(ws, { latest: 2 }).map((e) => e.seq)).toEqual([3, 4]);

    const keys = await log.publicKeys(ws, [], new Map());
    const check = await log.verify(ws, keys);
    expect(check).toMatchObject({ ok: true, count: 4, problems: [], lastHeaderSha256: entries[3].headerSha256 });
    expect(check.keyIds).toEqual(keys.map((k) => k.keyId));
    // Without keys, the keys known to the log are used.
    expect((await log.verify(ws)).ok).toBe(true);
  });

  it('reports tampering with the messages the dashboard checks for, keys without an algorithm being Ed25519', async () => {
    const { ws, log, signer } = setup();
    for (const n of [1, 2, 3]) await log.append(ws, 'rule.retired', { ruleIds: [`r${n}`], repoIds: [], ruleKey: `R-${n}` });
    const records = log.list(ws);
    const keys = [{ keyId: signer.keyId, publicKeyPem: signer.publicKeyPem }];
    expect(verifyEntries(records, keys).ok).toBe(true);
    expect(verifyEntries(records.map((r, i) => (i === 1 ? { ...r, bodyJson: r.bodyJson.replace('R-2', 'R-9') } : r)), keys).problems.join()).toContain('#2: body does not match');
    expect(verifyEntries(records.filter((_, i) => i !== 1), keys).problems.join()).toContain('records missing');
    expect(verifyEntries(records.map((r, i) => (i === 1 ? { ...r, headerJson: r.headerJson.replace('"v":1', '"v":2') } : r)), keys).problems.join()).toContain('bad signature');
    // A tampered body is not checked when bodies are off, or when it is withheld.
    const tampered = records.map((r, i) => (i === 1 ? { ...r, bodyJson: r.bodyJson.replace('R-2', 'R-9') } : r));
    expect(verifyEntries(tampered, keys, { bodies: false }).ok).toBe(true);
    expect(verifyEntries(records.map((r, i) => (i === 1 ? { ...r, bodyJson: undefined } : r)), keys).ok).toBe(true);
    expect(verifyEntries([], keys)).toMatchObject({ ok: true, count: 0, lastHeaderSha256: null });
  });

  it('verifies records signed with an ECDSA P-256 key', async () => {
    const { ws, log } = setup(ecSigner());
    await log.append(ws, 'rule.retired', { ruleIds: ['r1'], repoIds: [] });
    await log.append(ws, 'rule.retired', { ruleIds: ['r2'], repoIds: [] });
    const keys = await log.publicKeys(ws, [], new Map());
    expect(keys[0].algorithm).toBe('ECDSA_P256_SHA256');
    expect((await log.verify(ws, keys)).ok).toBe(true);
    expect(verifyRecords(log.records(ws), keys)).toEqual([]);
  });
});

describe('EvidenceRecorder: requested, revoked, rejected and share revocations', () => {
  const exception = (ws: string, userId: string, over: Partial<ExceptionRecord> = {}): ExceptionRecord => ({
    id: 'ex1',
    workspaceId: ws,
    ruleId: 'rule1',
    ruleKey: 'R-1',
    ruleTitle: 'Encrypt PII',
    repoId: 'repo1',
    repoName: 'acme/core',
    repoFullName: 'acme/core',
    fingerprint: 'fp1',
    pathGlob: null,
    reason: 'Behind a flag',
    requestedBy: 'github:tanvir',
    requesterLabel: '@tanvir',
    requestedFrom: 'github',
    requestedAt: '2026-10-01T00:00:00.000Z',
    requestedUntil: '2026-12-01T00:00:00.000Z',
    status: 'requested',
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: null,
    scanId: null,
    prNumber: 7,
    headSha: null,
    baseSha: null,
    filePath: 'api/app.py',
    startLine: 12,
    message: null,
    ...over,
  });

  it('writes scoped camelCase bodies that describeEvidence reads', async () => {
    const { ws, user, log, recorder } = setup();
    await recorder.exceptionRequested(exception(ws, user.id));
    const approved = exception(ws, user.id, { status: 'approved', decidedBy: user.id, decidedAt: '2026-10-02T00:00:00.000Z', decisionNote: 'ok', expiresAt: '2026-11-30T00:00:00.000Z' });
    await recorder.exceptionChanged(approved);
    await recorder.exceptionRevoked({ ...approved, status: 'revoked' }, user.id, '  shipped the fix ');
    await recorder.exceptionChanged({ ...approved, status: 'expired' });

    const version = { id: 'v2', ruleId: 'rule1', version: 2, status: 'rejected', documentId: null, sourceText: 'Personal data must be encrypted.', clause: { title: 'Encrypt PII', citation: 'Art. 32' }, clauseSha256: 'c'.repeat(64), scope: null, answers: null, effectiveFrom: null, card: null, createdBy: user.id, createdAt: '', approvedBy: user.id, approvedAt: '2026-10-03T00:00:00.000Z', decisionNote: 'Too broad' } as unknown as RuleVersion;
    const rule = { id: 'rule1', workspaceId: ws, key: 'R-1', title: 'Encrypt PII', createdAt: '', retiredAt: null, versions: [version] } as Rule;
    await recorder.ruleRejected(ws, rule, version, user.id);

    const share = { id: 's1', workspaceId: ws, label: 'Audit', counterpartyId: null, counterpartyName: null, ruleIds: ['rule1'], periodFrom: '', periodTo: '', createdBy: user.id, createdByName: null, createdAt: '', expiresAt: '', revokedAt: '2026-10-04T00:00:00.000Z', views: 0, lastViewedAt: null, status: 'revoked' } as ShareRecord;
    await recorder.shareChanged(share, 'revoked', user.id);

    const entries = log.list(ws);
    expect(entries.map((e) => e.header.type)).toEqual(['exception.requested', 'exception.approved', 'exception.revoked', 'exception.expired', 'rule.rejected', 'share.revoked']);
    for (const r of log.records(ws)) expect(bodyInScope(r.body, new Set(['rule1']), new Set(['repo1']))).toBe(!JSON.parse(r.header).type.startsWith('share.'));
    expect(entries[0].body).toMatchObject({ ruleKey: 'R-1', requesterLabel: '@tanvir', requestedFrom: 'github', requestedUntil: '2026-12-01T00:00:00.000Z', pullRequest: 7 });
    expect(entries[2].body).toMatchObject({ status: 'revoked', revokedBy: { name: 'Nusrat Jahan' }, note: 'shipped the fix' });
    expect(entries[4].body).toMatchObject({ ruleKey: 'R-1', version: 2, rejectedBy: { name: 'Nusrat Jahan' }, note: 'Too broad' });
    expect(entries[4].body).not.toHaveProperty('sourceText');
    expect(entries[5].body).toMatchObject({ revokedBy: { name: 'Nusrat Jahan' } });

    expect(entries.map((e) => describeEvidence(e).text)).toEqual([
      '@tanvir asked for an exception to R-1 at api/app.py:12',
      'Nusrat Jahan approved an exception to R-1 until 2026-11-30',
      'Nusrat Jahan revoked an exception to R-1',
      'An exception to R-1 expired',
      'Nusrat Jahan rejected a draft of R-1',
      'Nusrat Jahan revoked the share link "Audit"',
    ]);
    expect((await log.verify(ws)).ok).toBe(true);
  });
});

describe('describeEvidence', () => {
  const entry = (type: string, body: Record<string, unknown> | null) => ({ header: { type } as never, body });

  it('reads the snake_case bodies written before the merge', () => {
    expect(describeEvidence(entry('rule.approved', { rule: 'R-1', version: 1, title: 'Encrypt', decided_by: 'Nusrat' }))).toEqual({ kind: 'rule', text: 'Nusrat approved R-1 v1: Encrypt', link: '/app/rules' });
    expect(describeEvidence(entry('scan.completed', { scan: 's1', repo: 'acme/core', pr: 4, conclusion: 'failure', counts: { new: 2, existing: 1, waived: 1 } }))).toEqual({ kind: 'check-failed', text: 'Check failed on pull request #4 in acme/core: 2 new, 1 waived', link: '/app/checks/s1' });
    expect(describeEvidence(entry('exception.requested', { rule: 'R-1', location: 'a.py:3', requested_by: '@tanvir' })).text).toBe('@tanvir asked for an exception to R-1 at a.py:3');
    expect(describeEvidence(entry('exception.approved', { rule: 'R-1', decided_by: 'Nusrat', expires_at: '2026-12-01T00:00:00Z' })).text).toBe('Nusrat approved an exception to R-1 until 2026-12-01');
    expect(describeEvidence(entry('share.created', { created_by: 'Nusrat', label: 'Audit' })).text).toBe('Nusrat shared evidence: "Audit"');
  });

  it('reads recorder bodies and withheld records', async () => {
    const t = toEntry({ seq: 1, header: JSON.stringify({ type: 'scan.completed' }), headerSha256: '', body: JSON.stringify({ scanId: 's2', repo: 'acme/core', commit: 'abcdef1234', pullRequest: null, results: [{ new: ['a'], existing: ['b', 'c'], waived: [] }] }), signature: '' });
    expect(describeEvidence(t)).toEqual({ kind: 'scan', text: 'Scanned acme/core @ abcdef1: 3 open finding(s)', link: '/app/checks/s2' });
    expect(describeEvidence(entry('rule.approved', { ruleKey: 'R-2', version: 3, title: 'T', approvedBy: { userId: 'u', name: 'Tanvir', email: null } })).text).toBe('Tanvir approved R-2 v3: T');
    expect(describeEvidence(entry('exception.approved', null))).toEqual({ kind: 'withheld', text: 'exception.approved (details not in this share)', link: null });
    expect(describeEvidence(entry('something.else', {})).kind).toBe('other');
  });
});
