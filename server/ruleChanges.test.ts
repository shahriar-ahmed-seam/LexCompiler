import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getBanglaInitialClauses, getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { keyIdFor } from './enterprise/attestationSigner.js';
import { EvidenceLog } from './evidence/log.js';
import { EvidenceRecorder } from './evidence/records.js';
import { renderCheckOutput } from './github/checkRun.js';
import { refreshRegulatoryFeed, runDueJobs } from './product/feed.js';
import { createProductRouter } from './product/router.js';
import { globMatch, scanFilesScoped } from './product/scanner.js';
import { ProductStore, type Repo } from './product/store.js';
import type { LiveRegulatoryFeedItem, TargetRepoFile } from '../shared/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-changes-'));
const fixture: TargetRepoFile[] = Object.entries(INITIAL_REPO_FILES).map(([p, s]) => ({ path: p, language: s.language, description: s.description, content: s.content, lastModified: '2026-11-01T00:00:00Z' }));
const [DPA, , AI] = getInitialClauses();
const LOANS = [
  'import logging',
  '',
  'from fastapi import APIRouter, Header',
  'from pydantic import BaseModel',
  '',
  'logger = logging.getLogger("finhealth.loans")',
  'router = APIRouter()',
  '',
  '',
  'class LoanApplicant(BaseModel):',
  '    full_name: str',
  '    phone: str',
  '    national_id: str',
  '',
  '',
  '@router.post("/v1/loan-applications")',
  'async def create_application(applicant: LoanApplicant, x_tenant_id: str = Header(...)):',
  '    logger.info("new application")',
  '    return {"status": "received", "tenant": x_tenant_id}',
  '',
].join('\n');
const BANGLA_48 = getBanglaInitialClauses()[0];

let server: http.Server;
let origin: string;
let store: ProductStore;
let log: EvidenceLog;
let ws: string;
let repo: Repo;
const ids: Record<string, string> = {};

beforeAll(async () => {
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true, name: 'Arif' });
  ws = store.createWorkspace('FinHealth AI', arif.id).id;
  store.invite(ws, 'nusrat@example.test', 'legal', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'nusrat', email: 'nusrat@example.test', emailVerified: true, name: 'Nusrat' }));
  store.invite(ws, 'tanvir@example.test', 'engineer', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'tanvir', email: 'tanvir@example.test', emailVerified: true, name: 'Tanvir' }));
  const reposRoot = path.join(dataDir, 'repos');
  for (const f of fixture) {
    fs.mkdirSync(path.dirname(path.join(reposRoot, 'core-platform', f.path)), { recursive: true });
    fs.writeFileSync(path.join(reposRoot, 'core-platform', f.path), f.content);
  }
  // The loan endpoint from the walkthrough (product guide, Phase 2): R-1 fails it at line 20.
  fs.writeFileSync(path.join(reposRoot, 'core-platform', 'api', 'loan_applications.py'), LOANS);
  repo = store.addLocalRepo(ws, 'acme/core-platform', path.join(reposRoot, 'core-platform'));
  ids.klinikum = store.createCounterparty(ws, 'Klinikum Spree').id;
  ids.nodi = store.createCounterparty(ws, 'Nodi Microfinance').id;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  log = new EvidenceLog(store.db, async () => ({ keyId: keyIdFor(pem), algorithm: 'Ed25519', publicKeyPem: pem, backend: 'test', sign: async (d) => crypto.sign(null, d, privateKey) }));
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const sub = req.header('x-test-user');
    res.locals.principal = sub ? { sub, globalRole: 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use('/api', createProductRouter(store, null, { reposRoot, evidence: new EvidenceRecorder(log, store), refreshFeed: () => refreshRegulatoryFeed(store, async () => FEED) }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${ws}`;
});

afterAll(() => {
  server?.close();
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (p: string, user: string, body?: unknown) => {
  const res = await fetch(`${origin}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const approve = async (versionId: string, body: Record<string, unknown> = {}) => {
  const r = await call(`/rule-versions/${versionId}/approve`, 'nusrat', body);
  expect(r.status).toBe(200);
  return r.body;
};
const scan = async () => {
  const r = await call(`/repos/${repo.id}/scan`, 'tanvir', {});
  expect(r.status).toBe(200);
  return r.body as { findings: Array<{ ruleKey: string; filePath: string; startLine: number; message: string }> };
};

const FEED: LiveRegulatoryFeedItem[] = [
  {
    id: 'fr-1',
    source: 'FEDERAL_REGISTER',
    documentNumber: '2026-21001',
    title: 'Health data retention for claims processors',
    publicationDate: '2026-10-28',
    agencyOrBody: 'HHS',
    excerpt: 'Covered entities must purge personal health data from caches within 24 hours and must encrypt it at rest with tenant-isolated keys.',
    url: 'https://www.federalregister.gov/d/2026-21001',
    suggestedFramework: 'HIPAA',
  },
  {
    id: 'eu-1',
    source: 'EUR_LEX',
    documentNumber: '32026R0999',
    title: 'Corrigendum to Regulation (EU) 2024/1689',
    publicationDate: '2026-10-27',
    agencyOrBody: 'European Union',
    excerpt: 'This corrigendum amends Article 14 of Regulation (EU) 2024/1689.',
    url: 'https://eur-lex.europa.eu/eli/reg/2026/999/oj',
    suggestedFramework: 'EU_AI_ACT',
    kind: 'CHANGE_NOTICE',
  },
];

describe('scope by path', () => {
  it('proves a rule only on the files in its scope', async () => {
    const rule = { ruleId: 'r', ruleKey: 'R-9', versionId: 'v', version: 1, clause: { ...DPA, id: 'R-9' }, clauseSha256: 'x', scope: { all: true } };
    const all = await scanFilesScoped(fixture, [rule], new Map());
    const scoped = await scanFilesScoped(fixture, [rule], new Map([['R-9', ['workers/**']]]));
    expect(all.findings.some((f) => !f.filePath.startsWith('workers/'))).toBe(true);
    expect(scoped.findings.length).toBeGreaterThan(0);
    expect(scoped.findings.every((f) => globMatch('workers/**', f.filePath))).toBe(true);
    // The facts of the whole repository are kept for impact previews.
    expect(scoped.facts).toEqual(all.facts);
  });

  it('scene 5: a Bangla 48-hour rule for Nodi applies only to its paths, and narrowing R-1 to Klinikum drops it elsewhere', async () => {
    // R-1 for everyone (72 hours), then the counterparties' paths.
    const r1 = await call('/rules', 'nusrat', { rawLegalText: DPA.rawLegalText, title: DPA.title, citation: DPA.citation, category: DPA.category });
    ids.r1 = r1.body.rule.id;
    await approve(r1.body.version.id);
    expect((await call(`/counterparties/${ids.nodi}/scope`, 'tanvir', { scope: [] })).status).toBe(403);
    expect((await call(`/counterparties/${ids.nodi}/scope`, 'nusrat', { scope: [{ repoId: repo.id, pathGlob: '../etc' }] })).status).toBe(400);
    const nodi = await call(`/counterparties/${ids.nodi}/scope`, 'nusrat', {
      scope: [
        { repoId: repo.id, pathGlob: 'api/loan_*' },
        { repoId: repo.id, pathGlob: 'workers/**' },
      ],
    });
    expect(nodi.body.scope.map((s: { pathGlob: string }) => s.pathGlob).sort()).toEqual(['api/loan_*', 'workers/**']);
    await call(`/counterparties/${ids.klinikum}/scope`, 'nusrat', {
      scope: ['api/fastapi_intake.py', 'workers/**', 'schema/**'].map((g) => ({ repoId: repo.id, pathGlob: g })),
    });

    // The Bangla addendum: the card reads 48 hours; approved for Nodi as R-2.
    expect(BANGLA_48.rawLegalText).toContain('৪৮');
    const card = await call('/rule-card', 'nusrat', { text: BANGLA_48.rawLegalText });
    expect(card.body.values[0]).toMatchObject({ field: 'maxRetentionHours', value: 48 });
    const r2 = await call('/rules', 'nusrat', { rawLegalText: BANGLA_48.rawLegalText, citation: 'Bangladesh Bank addendum', scope: { counterpartyIds: [ids.nodi] } });
    expect(r2.body.version.scope).toEqual({ counterpartyIds: [ids.nodi] });
    await approve(r2.body.version.id);

    const first = await scan();
    const bangla = first.findings.filter((f) => f.ruleKey === 'R-2');
    expect(bangla.length).toBeGreaterThan(0);
    expect(bangla.every((f) => globMatch('api/loan_*', f.filePath) || globMatch('workers/**', f.filePath))).toBe(true);
    expect(bangla.map((f) => f.filePath)).toContain('workers/redis_cache_worker.py');
    expect(first.findings.filter((f) => f.ruleKey === 'R-1').map((f) => f.filePath)).toContain('api/loan_applications.py');
    const r1Paths = new Set(first.findings.filter((f) => f.ruleKey === 'R-1').map((f) => f.filePath));

    // Narrow R-1 to Klinikum: a new draft with that scope; once approved, R-1 is only proven there.
    const narrowed = await call(`/rules/${ids.r1}/rescope`, 'nusrat', { counterpartyIds: [ids.klinikum] });
    expect(narrowed.status).toBe(201);
    expect(narrowed.body.version).toMatchObject({ version: 2, status: 'draft', scope: { counterpartyIds: [ids.klinikum] } });
    await approve(narrowed.body.version.id);
    const after = await scan();
    const klinikumGlobs = ['api/fastapi_intake.py', 'workers/**', 'schema/**'];
    const r1After = after.findings.filter((f) => f.ruleKey === 'R-1');
    expect(r1After.every((f) => klinikumGlobs.some((g) => globMatch(g, f.filePath)))).toBe(true);
    // The loan endpoint is Nodi's, not Klinikum's: R-1 no longer reports it.
    expect(r1Paths.has('api/loan_applications.py')).toBe(true);
    expect(r1After.map((f) => f.filePath)).not.toContain('api/loan_applications.py');
  });
});

describe('effective dates', () => {
  it('scene 6: a future version is "coming up", does not fail scans, and fails once its date is moved to today', async () => {
    const v1 = await call('/rules', 'nusrat', { rawLegalText: AI.rawLegalText, title: AI.title, citation: AI.citation, category: AI.category });
    ids.r3 = v1.body.rule.id;
    await approve(v1.body.version.id);
    const strict = await call('/rules', 'nusrat', { ruleId: ids.r3, rawLegalText: AI.rawLegalText, category: AI.category, values: { minAiConfidenceThreshold: 0.92 } });
    expect(strict.body.version.version).toBe(2);
    const in3days = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    await approve(strict.body.version.id, { effectiveFrom: in3days });

    const coming = await call('/coming-up', 'tanvir');
    expect(coming.body.upcoming).toEqual([expect.objectContaining({ ruleKey: 'R-3', version: 2, effectiveFrom: in3days })]);
    const places = coming.body.results.filter((r: { ruleKey: string }) => r.ruleKey === 'R-3').flatMap((r: { findings: Array<{ filePath: string; startLine: number }> }) => r.findings.map((f) => `${f.filePath}:${f.startLine}`));
    expect(places.some((p: string) => p.startsWith('services/ai_credit_triage.ts:'))).toBe(true);

    // Still v1 in effect: the scan proves R-3 v1, not v2.
    const before = await scan();
    const v1Count = before.findings.filter((f) => f.ruleKey === 'R-3').length;

    // Only Legal moves the date; moving it to today puts v2 in effect and empties "Coming up".
    expect((await call(`/rule-versions/${strict.body.version.id}/effective`, 'tanvir', { effectiveFrom: new Date().toISOString() })).status).toBe(403);
    const moved = await call(`/rule-versions/${strict.body.version.id}/effective`, 'nusrat', { effectiveFrom: new Date(Date.now() - 1000).toISOString() });
    expect(moved.status).toBe(200);
    expect(moved.body.inEffect).toBe(true);
    expect((await call(`/rule-versions/${strict.body.version.id}/effective`, 'nusrat', { effectiveFrom: in3days })).status).toBe(409);
    expect((await call('/coming-up', 'tanvir')).body.results).toEqual([]);
    const afterScan = await scan();
    expect(afterScan.findings.filter((f) => f.ruleKey === 'R-3').length).toBeGreaterThanOrEqual(v1Count);
    const rescheduled = log.records(ws).map((r) => JSON.parse(r.header).type);
    expect(rescheduled).toContain('rule.rescheduled');
  });

  it('shows upcoming findings as warnings on a check, without failing it', () => {
    const out = renderCheckOutput({
      kind: 'pull_request',
      summary: { newCount: 0, existingCount: 0, waivedCount: 0, undecidedRuleKeys: [], perRule: [] },
      findings: [],
      rules: [{ ruleKey: 'R-3', title: 'Human review', version: 1 }],
      detailsUrl: 'http://x',
      defaultBranch: 'main',
      filesScanned: 5,
      truncated: false,
      lexcompilerVersion: 'test',
      upcoming: [{ ruleKey: 'R-3', version: 2, effectiveFrom: '2027-01-01T00:00:00.000Z', findings: [{ filePath: 'services/ai_credit_triage.ts', startLine: 20, endLine: 20, message: 'threshold 0.85 is below 0.92' }] }],
    });
    expect(out.title).toBe('All 1 rule pass · R-3 v2 will fail from 1 January 2027');
    expect(out.summary).toContain('- **R-3 v2** takes effect on 1 January 2027: 1 finding here will fail from then.');
    expect(out.annotations).toEqual([expect.objectContaining({ path: 'services/ai_credit_triage.ts', start_line: 20, annotation_level: 'warning', message: 'Will fail from 1 January 2027: threshold 0.85 is below 0.92' })]);
  });
});

describe('regulation feed', () => {
  it('stores new items once, drafts a rule change linked to its source, and refuses change notices', async () => {
    expect((await call('/feed/refresh', 'tanvir', {})).status).toBe(403);
    expect((await call('/feed/refresh', 'nusrat', {})).body).toEqual({ added: 2 });
    expect((await call('/feed/refresh', 'nusrat', {})).body).toEqual({ added: 0 });
    const feed = await call('/feed', 'tanvir');
    expect(feed.body.map((i: { id: string }) => i.id)).toEqual(['FEDERAL_REGISTER:2026-21001', 'EUR_LEX:32026R0999']);
    expect((await call('/inbox', 'nusrat')).body.feedDrafts.map((i: { id: string }) => i.id)).toEqual(['FEDERAL_REGISTER:2026-21001']);

    expect((await call(`/feed/${encodeURIComponent('EUR_LEX:32026R0999')}/draft`, 'nusrat', {})).status).toBe(409);
    const drafted = await call(`/feed/${encodeURIComponent('FEDERAL_REGISTER:2026-21001')}/draft`, 'nusrat', {});
    expect(drafted.status).toBe(201);
    expect(drafted.body.version).toMatchObject({ status: 'draft', documentId: drafted.body.documentId });
    expect(drafted.body.version.clause.citation).toBe('Federal Register 2026-21001');
    expect(drafted.body.version.card.values[0]).toMatchObject({ field: 'maxRetentionHours', value: 24 });
    // Nothing takes effect until approval.
    expect(store.rulesInEffect(ws).some((r) => r.ruleId === drafted.body.rule.id)).toBe(false);
    const doc = store.listDocuments(ws).find((d) => d.id === drafted.body.documentId)!;
    expect(doc).toMatchObject({ kind: 'regulation', title: 'Health data retention for claims processors' });
    expect((await call('/feed', 'tanvir')).body[0].documentId).toBe(drafted.body.documentId);
    expect((await call('/inbox', 'nusrat')).body.feedDrafts).toEqual([]);
  });
});

describe('daily jobs', () => {
  it('scan every default branch once a day (with evidence) and fetch the feed', async () => {
    const queued: string[] = [];
    store.upsertInstallation({ installationId: 7, accountLogin: 'acme', accountType: 'Organization' });
    store.upsertGithubRepo({ installationId: 7, githubRepoId: 4242, fullName: 'acme/finhealth-core-platform', defaultBranch: 'main' });
    store.linkInstallation(7, ws);
    const deps = { store, evidence: new EvidenceRecorder(log, store), enqueueGithubScan: (r: Repo, key: string) => (queued.push(`${r.fullName} ${key}`), `job-${queued.length}`), fetchFeed: async () => FEED };
    const day = new Date('2026-12-01T02:00:00Z');
    const first = await runDueJobs(deps, day);
    expect(first).toEqual(['feed: 0 new items', 'nightly scans: 1 local, 1 queued']);
    expect(queued).toEqual(['acme/finhealth-core-platform nightly:2026-12-01:' + store.getRepoByGithubId(4242)!.id]);
    const scheduled = store.listScans(ws).find((s) => s.trigger === 'scheduled')!;
    expect(store.scanEvidence(scheduled.id)).not.toBeNull();
    // Not again the same day; again the next day.
    expect(await runDueJobs(deps, new Date('2026-12-01T20:00:00Z'))).toEqual([]);
    expect(await runDueJobs(deps, new Date('2026-12-02T03:00:00Z'))).toHaveLength(2);
  });
});
