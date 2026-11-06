import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { keyIdFor, type AttestationSigner } from './enterprise/attestationSigner.js';
import { canonicalJson, EvidenceLog, verifyRecords, type PublicKeyEntry } from './evidence/log.js';
import { EvidenceRecorder } from './evidence/records.js';
import { createPublicEvidenceRouter } from './evidence/share.js';
import { readZip } from './evidence/zip.js';
import { verifyTimestamp } from './enterprise/timestamp.js';
import { runDueJobs } from './product/feed.js';
import { fakeTsa } from './testing/fakeTsa.js';
import { renderCheckOutput } from './github/checkRun.js';
import { createProductRouter } from './product/router.js';
import { ProductStore } from './product/store.js';
import { verifyHeadersInBrowser } from '../src/components/share/verifyInBrowser.js';

function testSigner(): AttestationSigner {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { keyId: keyIdFor(publicKeyPem), algorithm: 'Ed25519', publicKeyPem, backend: 'test', sign: async (d) => crypto.sign(null, d, privateKey) };
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-evidence-'));
const signer = testSigner();

describe('evidence log', () => {
  it('writes canonical JSON', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 'x' }], e: null })).toBe('{"a":[1,{"c":"x"}],"b":1,"e":null}');
  });

  it('chains and signs records, one at a time, and refuses changes', async () => {
    const db = openDatabase(':memory:');
    const store = new ProductStore(db);
    const ws = store.createWorkspace('W', null).id;
    const log = new EvidenceLog(db, async () => signer);
    // Concurrent appends still form one chain.
    const written = await Promise.all([1, 2, 3, 4, 5].map((n) => log.append(ws, 'rule.retired', { ruleIds: [`r${n}`], repoIds: [], n })));
    expect(written.map((w) => w.seq)).toEqual([1, 2, 3, 4, 5]);
    const records = log.records(ws);
    const keys = await log.publicKeys(ws, [], new Map());
    expect(verifyRecords(records, keys)).toEqual([]);
    expect(JSON.parse(records[1].header)).toMatchObject({ v: 1, seq: 2, type: 'rule.retired', prev: records[0].headerSha256, key_id: signer.keyId });

    expect(() => db.prepare('UPDATE evidence SET body = ? WHERE seq = 1').run('{}')).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM evidence WHERE seq = 1').run()).toThrow(/append-only/);

    // The same checks in a browser (Web Crypto).
    expect(await verifyHeadersInBrowser(records, keys)).toEqual([]);
    const forged = records.map((r, i) => (i === 2 ? { ...r, header: r.header.replace('"n"', '"n"').replace('rule.retired', 'rule.approved') } : r));
    expect(await verifyHeadersInBrowser(forged, keys)).toContain('#3: bad signature or unknown key');
    expect(await verifyHeadersInBrowser([records[0], records[2]], keys)).toEqual(expect.arrayContaining(['#3: records missing before it']));
    db.close();
  });

  it('names the evidence record in the check run summary', () => {
    const out = renderCheckOutput({
      kind: 'pull_request',
      summary: { newCount: 0, existingCount: 0, waivedCount: 0, undecidedRuleKeys: [], perRule: [] },
      findings: [],
      rules: [{ ruleKey: 'R-1', title: 'T', version: 1 }],
      detailsUrl: 'http://x',
      defaultBranch: 'main',
      filesScanned: 3,
      truncated: false,
      lexcompilerVersion: 'test',
      evidence: { seq: 12, headerSha256: 'ab'.repeat(32) },
    });
    expect(out.summary).toContain(`Evidence record #12 · header SHA-256 \`${'ab'.repeat(32)}\``);
  });
});

// ---------------------------------------------------------------- the auditor's share link, end to end

let server: http.Server;
let origin: string;
let store: ProductStore;
let log: EvidenceLog;
let ws: string;
const ruleIds: Record<string, string> = {};

beforeAll(async () => {
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true, name: 'Arif' });
  ws = store.createWorkspace('FinHealth AI', arif.id).id;
  store.invite(ws, 'nusrat@example.test', 'legal', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'nusrat', email: 'nusrat@example.test', emailVerified: true, name: 'Nusrat' }));
  store.invite(ws, 'tanvir@example.test', 'engineer', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'tanvir', email: 'tanvir@example.test', emailVerified: true, name: 'Tanvir' }));

  const reposRoot = path.join(dataDir, 'repos');
  for (const [rel, spec] of Object.entries(INITIAL_REPO_FILES)) {
    fs.mkdirSync(path.dirname(path.join(reposRoot, 'core-platform', rel)), { recursive: true });
    fs.writeFileSync(path.join(reposRoot, 'core-platform', rel), spec.content);
  }
  const repo = store.addLocalRepo(ws, 'acme/core-platform', path.join(reposRoot, 'core-platform'));
  store.addLocalRepo(ws, 'acme/unrelated', path.join(reposRoot, 'core-platform'));
  const klinikum = store.createCounterparty(ws, 'Klinikum Spree');
  store.setCounterpartyScope(ws, klinikum.id, [{ repoId: repo.id, pathGlob: '**' }]);

  log = new EvidenceLog(store.db, async () => signer);
  const evidence = new EvidenceRecorder(log, store);
  const app = express();
  app.use(createPublicEvidenceRouter({ store, log, keysFor: (id) => log.publicKeys(id, [], new Map()), publicUrl: 'http://lexc.test' }));
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const sub = req.header('x-test-user');
    res.locals.principal = sub ? { sub, globalRole: sub === 'root' ? 'admin' : 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use('/api', createProductRouter(store, null, { reposRoot, evidence, publicUrl: 'http://lexc.test' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (p: string, user: string | null, body?: unknown) => {
  const res = await fetch(`${origin}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'User-Agent': 'auditor-browser/1.0' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

/** Writes the pack to a folder and runs its verify.mjs with the given keys file. */
function runVerify(files: Map<string, Buffer>, keysJson: string, change?: (dir: string) => void): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(dataDir, 'pack-'));
  for (const [name, data] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  change?.(dir);
  const keysFile = path.join(dataDir, `keys-${crypto.randomUUID()}.json`);
  fs.writeFileSync(keysFile, keysJson);
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(dir, 'verify.mjs'), dir, keysFile], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, out: e.stdout };
  }
}

describe('share links and the evidence pack', () => {
  it('records approvals, scans and exceptions, and shares them with an auditor who can verify the pack', async () => {
    // Nusrat approves R-1 and R-2 (built-in clauses), which writes rule.approved records.
    for (const c of getInitialClauses().slice(0, 2)) {
      const draft = await call(`/api/workspaces/${ws}/rules`, 'nusrat', { rawLegalText: c.rawLegalText, title: c.title, citation: c.citation, category: c.category });
      expect(draft.status).toBe(201);
      const ok = await call(`/api/workspaces/${ws}/rule-versions/${draft.body.version.id}/approve`, 'nusrat', {});
      expect(ok.status).toBe(200);
      expect(ok.body.evidenceSeq).toBeGreaterThan(0);
      ruleIds[draft.body.rule.key] = draft.body.rule.id;
    }
    // Scans of both repositories write scan.completed records with fingerprints per rule.
    const repos = store.listRepos(ws);
    const main = repos.find((r) => r.fullName === 'acme/core-platform')!;
    const scan = await call(`/api/workspaces/${ws}/repos/${main.id}/scan`, 'tanvir', {});
    expect(scan.body.evidence.seq).toBeGreaterThan(0);
    await call(`/api/workspaces/${ws}/repos/${repos.find((r) => r.fullName === 'acme/unrelated')!.id}/scan`, 'tanvir', {});
    const r1 = scan.body.findings.find((f: { ruleKey: string }) => f.ruleKey === 'R-1');
    const asked = await call(`/api/workspaces/${ws}/exceptions`, 'tanvir', { scanId: scan.body.id, fingerprint: r1.fingerprint, reason: 'Tenant keys arrive with LN-12' });
    const until = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    expect((await call(`/api/workspaces/${ws}/exceptions/${asked.body.id}/approve`, 'nusrat', { note: 'Until LN-12 ships', expiresAt: until })).status).toBe(200);

    // Engineers can't share; Legal shares R-1 with Klinikum Spree for this month, for 7 days.
    const klinikum = store.listCounterparties(ws)[0];
    const now = new Date();
    const period = { periodFrom: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), periodTo: new Date(Date.now() + 3600 * 1000).toISOString() };
    const shareBody = { ruleIds: [ruleIds['R-1']], counterpartyId: klinikum.id, ...period, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), label: 'Q4 audit' };
    expect((await call(`/api/workspaces/${ws}/shares`, 'tanvir', shareBody)).status).toBe(403);
    const created = await call(`/api/workspaces/${ws}/shares`, 'nusrat', shareBody);
    expect(created.status).toBe(201);
    expect(created.body.url).toBe(`http://lexc.test/share/${created.body.token}`);
    const token = created.body.token as string;
    expect(JSON.stringify(store.db.prepare('SELECT * FROM shares').all())).not.toContain(token);

    // The auditor opens it without an account.
    const view = await call(`/api/share/${token}`, null);
    expect(view.status).toBe(200);
    expect(view.body.rules).toEqual([expect.objectContaining({ key: 'R-1', versions: [expect.objectContaining({ version: 1, approvedBy: 'Nusrat' })] })]);
    expect(view.body.repos).toEqual(['acme/core-platform']);
    expect(view.body.scans).toHaveLength(1);
    expect(view.body.scans[0]).toMatchObject({ repo: 'acme/core-platform', evidence: { seq: scan.body.evidence.seq } });
    expect(view.body.exceptions).toEqual([expect.objectContaining({ ruleKey: 'R-1', status: 'approved', decidedBy: 'Nusrat', decisionNote: 'Until LN-12 ships' })]);
    // No code: findings carry messages and lines, never snippets.
    expect(JSON.stringify(view.body)).not.toMatch(/snippet/);

    // Every header of the period, but only the bodies about R-1 in Klinikum's repository.
    const all = log.records(ws);
    expect(view.body.evidence.headers.map((h: { seq: number }) => h.seq)).toEqual(all.map((r) => r.seq));
    const types = (seqs: number[]) => seqs.map((s) => JSON.parse(all.find((r) => r.seq === s)!.header).type);
    expect(types(view.body.evidence.bodySeqs)).toEqual(['rule.approved', 'scan.completed', 'exception.requested', 'exception.approved']);

    // The pack verifies with keys from the .well-known URL (standing in for FinHealth's website).
    const keys = await call(`/.well-known/lexcompiler/${ws}/keys.json`, null);
    expect((keys.body as PublicKeyEntry[]).map((k) => k.keyId)).toEqual([signer.keyId]);
    const keysJson = JSON.stringify(keys.body);
    const zip = await call(`/api/share/${token}/pack.zip`, null);
    expect(zip.status).toBe(200);
    const files = readZip(zip.body as Buffer);
    expect([...files.keys()].sort()).toEqual(['README.txt', 'bodies.jsonl', 'exceptions.json', 'headers.jsonl', 'keys.json', 'report.html', 'rules/R-1.json', 'sarif/acme_core-platform.sarif.json', 'verify.mjs']);
    expect(files.get('report.html')!.toString()).toContain('Compliance evidence: FinHealth AI');
    expect(JSON.parse(files.get('sarif/acme_core-platform.sarif.json')!.toString()).runs[0].results.length).toBeGreaterThan(0);
    const good = runVerify(files, keysJson);
    expect(good).toEqual({ code: 0, out: `OK: ${all.length} signed headers in an unbroken chain; 4 bodies match.\n` });

    // Tampering is detected.
    const bodyChanged = runVerify(files, keysJson, (dir) => {
      const f = path.join(dir, 'bodies.jsonl');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Until LN-12 ships', 'Until LN-12 shipz'));
    });
    expect(bodyChanged.code).toBe(1);
    expect(bodyChanged.out).toMatch(/^body #\d+: does not match its signed header/m);
    const lineDeleted = runVerify(files, keysJson, (dir) => {
      const f = path.join(dir, 'headers.jsonl');
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.splice(2, 1);
      fs.writeFileSync(f, lines.join('\n'));
    });
    expect(lineDeleted.out).toMatch(/#4: records missing before it/);
    const headerEdited = runVerify(files, keysJson, (dir) => {
      const f = path.join(dir, 'headers.jsonl');
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const row = JSON.parse(lines[0]);
      row.header = row.header.replace('rule.approved', 'rule.retired');
      lines[0] = JSON.stringify(row);
      fs.writeFileSync(f, lines.join('\n'));
    });
    expect(headerEdited.out).toMatch(/#1: bad signature or unknown key/);
    // Keys from somewhere else don't verify the pack.
    expect(runVerify(files, JSON.stringify([{ ...keys.body[0], publicKeyPem: testSigner().publicKeyPem }])).out).toMatch(/bad signature/);

    // Legal sees the views (page and download) and revokes the link; it stops working.
    const views = await call(`/api/workspaces/${ws}/shares/${created.body.id}/views`, 'nusrat');
    expect(views.body).toHaveLength(2);
    expect(views.body[0]).toMatchObject({ userAgent: 'auditor-browser/1.0' });
    expect((await call(`/api/workspaces/${ws}/shares/${created.body.id}/revoke`, 'nusrat', {})).body.revokedAt).toBeTruthy();
    expect((await call(`/api/share/${token}`, null)).status).toBe(404);
    expect((await call(`/api/share/${token}/pack.zip`, null)).status).toBe(404);
    expect(JSON.parse(log.records(ws).at(-1)!.header).type).toBe('share.revoked');
    expect(verifyRecords(log.records(ws), await log.publicKeys(ws, [], new Map()))).toEqual([]);
  });

  it('records an exception expiring, and refuses bad share requests', async () => {
    const exception = store.listExceptions(ws, { status: 'approved' })[0];
    expect((await call(`/api/workspaces/${ws}/exceptions/${exception.id}/expiry`, 'root', { expiresAt: new Date(Date.now() - 1000).toISOString() })).body.status).toBe('expired');
    const last = log.records(ws).at(-1)!;
    expect(JSON.parse(last.header).type).toBe('exception.expired');
    expect(JSON.parse(last.body)).toMatchObject({ exceptionId: exception.id, status: 'expired' });

    const base = { ruleIds: [ruleIds['R-1']], periodFrom: '2026-10-01', periodTo: '2026-10-31' };
    expect((await call(`/api/workspaces/${ws}/shares`, 'nusrat', { ...base, ruleIds: [] })).status).toBe(400);
    expect((await call(`/api/workspaces/${ws}/shares`, 'nusrat', { ...base, expiresAt: '2000-01-01' })).status).toBe(400);
    expect((await call(`/api/workspaces/${ws}/shares`, 'nusrat', { ...base, expiresAt: new Date(Date.now() + 400 * 864e5).toISOString() })).status).toBe(400);
    expect((await call('/api/share/lexc_share_nope', null)).status).toBe(404);
    expect((await call('/.well-known/lexcompiler/nope/keys.json', null)).status).toBe(404);
  });
});

describe('RFC 3161 timestamps of the evidence chain', () => {
  it('has a Time-Stamp Authority vouch for the newest header once, and ships the token in the pack', async () => {
    const tsa = (await fakeTsa()) as unknown as typeof fetch;
    const newest = log.records(ws).at(-1)!;
    const stamp = await log.timestampLatest(ws, 'https://tsa.test/ts', tsa);
    expect(stamp).toMatchObject({ seq: newest.seq, headerSha256: newest.headerSha256, tsaUrl: 'https://tsa.test/ts' });
    expect(await verifyTimestamp(stamp!.tokenBase64, Buffer.from(newest.header, 'utf8'))).toMatchObject({ valid: true });
    // Nothing new since: no second token for the same header.
    expect(await log.timestampLatest(ws, 'https://tsa.test/ts', tsa)).toBeNull();

    const now = new Date();
    const share = await call(`/api/workspaces/${ws}/shares`, 'nusrat', {
      ruleIds: [ruleIds['R-1']],
      periodFrom: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      periodTo: new Date(Date.now() + 3600 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
    });
    const view = await call(`/api/share/${share.body.token}`, null);
    expect(view.body.evidence.timestamps).toEqual([{ seq: newest.seq, headerSha256: newest.headerSha256, tsaUrl: 'https://tsa.test/ts', genTime: stamp!.genTime }]);
    const files = readZip((await call(`/api/share/${share.body.token}/pack.zip`, null)).body as Buffer);
    expect(files.get(`timestamps/${newest.seq}.tsr`)!.equals(Buffer.from(stamp!.tokenBase64, 'base64'))).toBe(true);
    expect(files.get(`timestamps/${newest.seq}.header`)!.toString('utf8')).toBe(newest.header);
    expect(files.get('README.txt')!.toString()).toContain('openssl ts -verify -token_in');
    const keysJson = JSON.stringify((await call(`/.well-known/lexcompiler/${ws}/keys.json`, null)).body);
    expect(runVerify(files, keysJson).out).toMatch(/OK: .* 1 timestamped headers match the chain\.\n$/);
    // A stamped header that isn't the one in the chain is reported.
    const swapped = runVerify(files, keysJson, (dir) => fs.writeFileSync(path.join(dir, 'timestamps', `${newest.seq}.header`), newest.header.replace('"v":1', '"v":2')));
    expect(swapped.out).toContain(`timestamp #${newest.seq}: the stamped header is not the one in headers.jsonl`);
  });

  it('timestamps each workspace once a day in the daily jobs', async () => {
    const db = openDatabase(':memory:');
    const s2 = new ProductStore(db);
    const w = s2.createWorkspace('W', null).id;
    const log2 = new EvidenceLog(db, async () => signer);
    await log2.append(w, 'rule.retired', { ruleIds: ['r'], repoIds: [] });
    const deps = { store: s2, evidence: new EvidenceRecorder(log2, s2), enqueueGithubScan: () => null, fetchFeed: async () => [], timestamps: { tsaUrl: 'https://tsa.test/ts', fetchImpl: (await fakeTsa()) as unknown as typeof fetch } };
    expect(await runDueJobs(deps, new Date('2026-12-01T01:00:00Z'))).toContain('timestamps: 1 headers');
    expect(log2.timestamps(w)).toHaveLength(1);
    expect((await runDueJobs(deps, new Date('2026-12-01T05:00:00Z'))).some((d) => d.startsWith('timestamps'))).toBe(false);
    db.close();
  });
});
