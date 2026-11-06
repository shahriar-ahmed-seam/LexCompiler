import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { importSPKI, jwtVerify } from 'jose';
import zlib from 'node:zlib';
import { create as createTar, Header } from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { checkConclusion } from './github/checkRun.js';
import { GitHubApp, verifyWebhookSignature } from './github/client.js';
import { createCommentJobHandler, rerunCheckForException } from './github/exceptions.js';
import { createGitHubRoutes, type BrowserAuth } from './github/routes.js';
import { createScanJobHandler } from './github/scanJob.js';
import { openFixPullRequest } from './github/fixes.js';
import { AiGateway } from './ai/gateway.js';
import { scanFiles } from './product/scanner.js';
import { readTarballSources } from './github/tarball.js';
import { createWebhookHandler } from './github/webhooks.js';
import { JobQueue } from './jobs/queue.js';
import { compileClauseSync } from './product/clauses.js';
import { ProductStore } from './product/store.js';
import { keyIdFor } from './enterprise/attestationSigner.js';
import { EvidenceLog, verifyRecords } from './evidence/log.js';
import { EvidenceRecorder } from './evidence/records.js';

const APP_ID = '123';
const INSTALLATION = 7;
const REPO_ID = 42;
const FULL_NAME = 'acme/core-platform';
const SECRET = 'webhook-secret';
const BASE = 'b'.repeat(40);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const HEAD3 = '3'.repeat(40);
const HEAD4 = '4'.repeat(40);

const PRIVACY = [
  'import hashlib',
  '',
  '',
  'def redact_pii(value: str) -> str:',
  '    """Replaces a personal value with a short, non-reversible token for logs."""',
  '    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]',
  '    return f"[REDACTED:{digest}]"',
  '',
].join('\n');
const LOANS = [
  'import logging',
  '',
  'from fastapi import APIRouter, Header',
  'from pydantic import BaseModel',
  '',
  'from api.privacy import redact_pii',
  '',
  'logger = logging.getLogger("finhealth.loans")',
  'router = APIRouter()',
  '',
  '',
  'class LoanApplicant(BaseModel):',
  '    full_name: str',
  '    phone: str',
  '    national_id: str',
  '    requested_amount: int',
  '',
  '',
  '@router.post("/v1/loan-applications")',
  'async def create_application(applicant: LoanApplicant, x_tenant_id: str = Header(...)):',
  '    logger.info(f"new application phone={applicant.phone} national_id={applicant.national_id}")',
  '    return {"status": "received", "tenant": x_tenant_id}',
  '',
].join('\n');
const LOANS_FIXED = LOANS.replace(
  'phone={applicant.phone} national_id={applicant.national_id}',
  'phone={redact_pii(applicant.phone)} national_id={redact_pii(applicant.national_id)}'
);

const fixture = Object.fromEntries(Object.entries(INITIAL_REPO_FILES).map(([p, spec]) => [p, spec.content]));

/**
 * A .tar.gz with one top-level folder, like GitHub's archives. `symlinks` (path → target) are
 * written as tar entries, because creating a symlink on disk needs extra privileges on Windows.
 */
async function targz(files: Record<string, string>, root: string, extra?: (dir: string) => void, symlinks: Record<string, string> = {}): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-tar-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    extra?.(path.join(dir, root));
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createTar({ cwd: dir, portable: true }, [root]);
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    let tar = Buffer.concat(chunks);
    // Drop the end-of-archive zero blocks, append the symlink headers, then end the archive again.
    const zero = Buffer.alloc(512);
    while (tar.length >= 512 && tar.subarray(tar.length - 512).equals(zero)) tar = tar.subarray(0, tar.length - 512);
    const links = Object.entries(symlinks).map(([rel, target]) => {
      const block = Buffer.alloc(512);
      new Header({ path: `${root}/${rel}`, type: 'SymbolicLink', linkpath: target, mode: 0o777, size: 0, mtime: new Date(0) }).encode(block, 0);
      return block;
    });
    return zlib.gzipSync(Buffer.concat([tar, ...links, Buffer.alloc(1024)]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake GitHub: REST API, OAuth and archives, recording what LexCompiler sends. */
async function startFakeGitHub(publicKeyPem: string) {
  const archives = new Map<string, Buffer>();
  /** Connections to drop before an archive is served, to simulate a flaky network. */
  const dropTarball = new Map<string, number>();
  const tarballRequests: string[] = [];
  const checkRuns: Array<{ id: number; create: Record<string, unknown>; patches: Array<Record<string, unknown>> }> = [];
  const comments: Array<{ issue: number; body: string }> = [];
  /** Changed files per pull request (GET pulls/:n/files), and what the app wrote through the API. */
  const prFiles = new Map<number, Array<{ filename: string; patch: string }>>();
  const reviews: Array<{ pr: number; body: Record<string, unknown> }> = [];
  const blobs = new Map<string, string>();
  const trees: Array<Record<string, unknown>> = [];
  const commits: Array<Record<string, unknown>> = [];
  const refs = new Map<string, string>();
  const pulls: Array<Record<string, unknown>> = [];
  /** An App registered with Contents: read only (before fix PRs existed). */
  const flags = { readOnlyContents: false };
  const appKey = await importSPKI(publicKeyPem, 'RS256');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = new URL(req.url!, 'http://x');
      const auth = req.headers.authorization || '';
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const body = raw ? JSON.parse(raw) : {};
      const m = (re: RegExp) => url.pathname.match(re);
      try {
        let g: RegExpMatchArray | null;
        if ((g = m(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === 'POST') {
          const { payload } = await jwtVerify(auth.replace('Bearer ', ''), appKey);
          if (payload.iss !== APP_ID) return json(401, {});
          return json(201, { token: `inst-${g[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
        }
        if (url.pathname.startsWith('/repos/') && auth !== `Bearer inst-${INSTALLATION}`) return json(401, { message: 'Bad credentials' });
        if ((g = m(/^\/repos\/acme\/core-platform\/tarball\/(\w+)$/))) {
          tarballRequests.push(g[1]);
          const drops = dropTarball.get(g[1]) ?? 0;
          if (drops > 0) {
            dropTarball.set(g[1], drops - 1);
            req.socket.destroy();
            return;
          }
          const a = archives.get(g[1]);
          if (!a) return json(404, {});
          res.writeHead(200, { 'Content-Type': 'application/x-gzip', 'Content-Length': a.length });
          return res.end(a);
        }
        if ((g = m(/^\/repos\/acme\/core-platform\/commits\/(\w+)$/))) return json(200, { sha: g[1] === 'main' ? BASE : g[1] });
        if ((g = m(/^\/repos\/acme\/core-platform\/compare\/(\w+)\.\.\.(\w+)$/))) return json(200, { merge_base_commit: { sha: g[1] } });
        if (m(/^\/repos\/acme\/core-platform\/check-runs$/) && req.method === 'POST') {
          const run = { id: checkRuns.length + 1, create: body, patches: [] };
          checkRuns.push(run);
          return json(201, { id: run.id });
        }
        if ((g = m(/^\/repos\/acme\/core-platform\/check-runs\/(\d+)$/)) && req.method === 'PATCH') {
          checkRuns[Number(g[1]) - 1].patches.push(body);
          return json(200, { id: Number(g[1]) });
        }
        if ((g = m(/^\/repos\/acme\/core-platform\/issues\/(\d+)\/comments$/)) && req.method === 'POST') {
          comments.push({ issue: Number(g[1]), body: String(body.body) });
          return json(201, { id: comments.length });
        }
        if ((g = m(/^\/repos\/acme\/core-platform\/pulls\/(\d+)\/files$/))) return json(200, url.searchParams.get('page') === '1' ? (prFiles.get(Number(g[1])) ?? []) : []);
        if ((g = m(/^\/repos\/acme\/core-platform\/pulls\/(\d+)\/reviews$/)) && req.method === 'POST') {
          reviews.push({ pr: Number(g[1]), body });
          return json(200, { id: reviews.length });
        }
        if (m(/^\/repos\/acme\/core-platform\/git\/blobs$/) && req.method === 'POST') {
          if (flags.readOnlyContents) return json(403, { message: 'Resource not accessible by integration' });
          const sha = crypto.createHash('sha1').update(String(body.content)).digest('hex');
          blobs.set(sha, String(body.content));
          return json(201, { sha });
        }
        if ((g = m(/^\/repos\/acme\/core-platform\/git\/commits\/(\w+)$/)) && req.method === 'GET') return json(200, { sha: g[1], tree: { sha: `tree-${g[1]}` } });
        if (m(/^\/repos\/acme\/core-platform\/git\/trees$/) && req.method === 'POST') {
          trees.push(body);
          return json(201, { sha: `tree-new-${trees.length}` });
        }
        if (m(/^\/repos\/acme\/core-platform\/git\/commits$/) && req.method === 'POST') {
          commits.push(body);
          return json(201, { sha: `c0ffee${commits.length}`.padEnd(40, '0') });
        }
        if (m(/^\/repos\/acme\/core-platform\/git\/refs$/) && req.method === 'POST') {
          if (refs.has(String(body.ref))) return json(422, { message: 'Reference already exists' });
          refs.set(String(body.ref), String(body.sha));
          return json(201, { ref: body.ref });
        }
        if (m(/^\/repos\/acme\/core-platform\/pulls$/) && req.method === 'POST') {
          pulls.push(body);
          return json(201, { number: 100 + pulls.length, html_url: `https://github.com/acme/core-platform/pull/${100 + pulls.length}` });
        }
        if (url.pathname === '/installation/repositories') return json(200, { repositories: [{ id: REPO_ID, full_name: FULL_NAME, default_branch: 'main' }] });
        if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
          return body.code === 'good-code' && body.client_secret === 'client-secret' ? json(200, { access_token: 'user-token' }) : json(200, { error: 'bad_verification_code' });
        }
        if (url.pathname === '/user/installations') {
          return auth === 'Bearer user-token' ? json(200, { installations: [{ id: INSTALLATION, account: { login: 'acme', type: 'Organization' } }] }) : json(401, {});
        }
        json(404, { message: `no fake for ${req.method} ${url.pathname}` });
      } catch (err) {
        json(500, { message: String(err) });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, archives, dropTarball, tarballRequests, checkRuns, comments, prFiles, reviews, blobs, trees, commits, refs, pulls, flags };
}

let fake: Awaited<ReturnType<typeof startFakeGitHub>>;
let api: http.Server;
let lex: string;
let store: ProductStore;
let queue: JobQueue;
let workspaceId: string;
let getApp: () => GitHubApp;
let evidenceLog: EvidenceLog;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-github-'));

beforeAll(async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fake = await startFakeGitHub(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  fake.archives.set(BASE, await targz({ ...fixture, 'api/privacy.py': PRIVACY }, `acme-core-platform-${BASE.slice(0, 7)}`));
  fake.archives.set(HEAD1, await targz({ ...fixture, 'api/privacy.py': PRIVACY, 'api/loan_applications.py': LOANS }, `acme-core-platform-${HEAD1.slice(0, 7)}`));
  fake.archives.set(HEAD2, await targz({ ...fixture, 'api/privacy.py': PRIVACY, 'api/loan_applications.py': LOANS_FIXED }, `acme-core-platform-${HEAD2.slice(0, 7)}`));
  fake.archives.set(HEAD3, fake.archives.get(HEAD2)!);
  fake.archives.set(HEAD4, fake.archives.get(HEAD2)!);

  const db = openDatabase(path.join(dataDir, 'lexcompiler.db'));
  store = new ProductStore(db);
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  workspaceId = store.createWorkspace('FinHealth AI', arif.id).id;
  for (const c of getInitialClauses()) {
    const key = store.nextRuleKey(workspaceId);
    const clause = compileClauseSync({ text: c.rawLegalText, key, title: c.title, citation: c.citation, category: c.category });
    const { version } = store.createRuleDraft({ workspaceId, title: c.title, sourceText: c.rawLegalText, clause, createdBy: arif.id });
    store.approveRuleVersion(workspaceId, version.id, arif.id);
  }

  const urls = { apiUrl: fake.base, webUrl: fake.base };
  const githubApp = new GitHubApp(
    {
      appId: APP_ID,
      slug: 'lexc-test',
      name: 'LexCompiler Test',
      htmlUrl: null,
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      webhookSecret: SECRET,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      source: 'file',
    },
    urls,
    fetch,
    { retryDelaysMs: [0, 0, 0] }
  );
  getApp = () => githubApp;
  const publicUrl = 'http://lexc.test';
  const evKeys = crypto.generateKeyPairSync('ed25519');
  const evPem = evKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  evidenceLog = new EvidenceLog(db, async () => ({ keyId: keyIdFor(evPem), algorithm: 'Ed25519', publicKeyPem: evPem, backend: 'test', sign: async (d) => crypto.sign(null, d, evKeys.privateKey) }));
  const evidence = new EvidenceRecorder(evidenceLog, store);
  queue = new JobQueue(db, { scan: createScanJobHandler({ store, getApp, publicUrl, evidence }), github_comment: createCommentJobHandler({ getApp }) }, { maxAttempts: 1 });
  const auth: BrowserAuth = {
    async principal(req) {
      const sub = req.header('x-test-user');
      return sub ? { sub, globalRole: sub === 'root' ? 'admin' : 'member', via: 'oidc-session' } : null;
    },
    loginUrl: () => '/login',
  };
  const app = express();
  app.post('/api/github/webhooks', express.raw({ type: () => true }), createWebhookHandler({ store, getApp, queue }));
  app.use(createGitHubRoutes({ store, queue, getApp, onRegistered: () => undefined, auth, publicUrl, urls, webhookUrl: 'https://smee.io/test' }));
  api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  lex = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  api?.close();
  fake?.server.close();
  // Windows cannot delete an open database file.
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let deliveries = 0;
async function deliver(event: string, payload: Record<string, unknown>, options: { id?: string; secret?: string } = {}) {
  const body = JSON.stringify({ installation: { id: INSTALLATION, account: { login: 'acme', type: 'Organization' } }, ...payload });
  const signature = `sha256=${crypto.createHmac('sha256', options.secret ?? SECRET).update(body).digest('hex')}`;
  const res = await fetch(`${lex}/api/github/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': options.id ?? `d-${++deliveries}`, 'X-Hub-Signature-256': signature },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const repository = { id: REPO_ID, full_name: FULL_NAME, default_branch: 'main' };
const prPayload = (action: string, head: string) => ({ action, repository, pull_request: { number: 5, head: { sha: head }, base: { sha: BASE } } });
const browse = (p: string, user = 'arif') => fetch(`${lex}${p}`, { headers: { 'x-test-user': user }, redirect: 'manual' });
const lastRun = () => fake.checkRuns[fake.checkRuns.length - 1];
const finalPatch = (run = lastRun()) => run.patches.find((p) => p.status === 'completed') as { conclusion: string; output: { title: string; annotations: Array<{ path: string; start_line: number; annotation_level: string; title: string }> } };

// Several cases run full scans; under a busy machine they need more than the default 30 s, and a
// case that timed out would keep draining the shared job table into the next one.
describe('GitHub App', { timeout: 120_000 }, () => {
  it('verifies webhook signatures in constant time', () => {
    const body = Buffer.from('{"a":1}');
    const good = `sha256=${crypto.createHmac('sha256', 's').update(body).digest('hex')}`;
    expect(verifyWebhookSignature('s', body, good)).toBe(true);
    expect(verifyWebhookSignature('other', body, good)).toBe(false);
    expect(verifyWebhookSignature('s', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s', body, 'sha256=00')).toBe(false);
  });

  it('accepts a body a relay re-stringified only when the signature still matches', () => {
    // GitHub escapes <, > and & in its JSON; smee forwards JSON.stringify(JSON.parse(body)).
    const fromGitHub = Buffer.from('{"title":"Retention \\u0026 keys \\u003cR-1\\u003e","n":1}');
    const signature = `sha256=${crypto.createHmac('sha256', 's').update(fromGitHub).digest('hex')}`;
    const relayed = Buffer.from(JSON.stringify(JSON.parse(fromGitHub.toString())));
    expect(relayed.toString()).toBe('{"title":"Retention & keys <R-1>","n":1}');
    expect(verifyWebhookSignature('s', relayed, signature)).toBe(false);
    expect(verifyWebhookSignature('s', relayed, signature, { relayReencoded: true })).toBe(true);
    expect(verifyWebhookSignature('other', relayed, signature, { relayReencoded: true })).toBe(false);
    const tampered = Buffer.from('{"title":"Retention & keys <R-9>","n":1}');
    expect(verifyWebhookSignature('s', tampered, signature, { relayReencoded: true })).toBe(false);
  });

  it('reads only source files from a repository archive, in memory', async () => {
    const archive = await targz(
      { 'api/app.py': 'x = 1\n', 'node_modules/pkg/evil.py': 'x = 2\n', '.github/hidden.py': 'x = 3\n', 'types.d.ts': 'export {}\n', 'README.md': '# hi' },
      'acme-repo-abc1234',
      (root) => fs.writeFileSync(path.join(root, 'api', 'big.py'), 'x = 1\n'.repeat(200_000)),
      { 'api/link.py': '/etc/passwd' }
    );
    const sources = await readTarballSources(archive);
    expect(sources.files.map((f) => f.path)).toEqual(['api/app.py']);
    expect(sources.skippedLargeFiles).toEqual(['api/big.py']);
  });

  it('rejects forged deliveries and ignores redeliveries', async () => {
    expect((await deliver('ping', { zen: 'hi' }, { secret: 'wrong' })).status).toBe(401);
    expect((await deliver('ping', { zen: 'hi' }, { id: 'same' })).status).toBe(202);
    expect(await deliver('ping', { zen: 'hi' }, { id: 'same' })).toEqual({ status: 200, body: { duplicate: true } });
  });

  it('asks to connect a repository whose installation is not linked to a workspace', async () => {
    expect((await deliver('installation', { action: 'created', repositories: [{ id: REPO_ID, full_name: FULL_NAME }] })).status).toBe(202);
    expect(store.getRepoByGithubId(REPO_ID)?.workspaceId).toBeNull();
    await deliver('pull_request', prPayload('opened', HEAD1));
    expect(await queue.drain()).toBe(1);
    expect(lastRun().create).toMatchObject({ name: 'LexCompiler / compliance', head_sha: HEAD1, conclusion: 'action_required' });
  });

  it('links an installation only after GitHub confirms the person can access it', async () => {
    // A forged installation id: the person's GitHub account can't access it.
    const forged = await browse(`/github/setup?installation_id=999&setup_action=install`);
    expect(forged.status).toBe(302);
    const forgedState = new URL(forged.headers.get('location')!).searchParams.get('state')!;
    const rejected = await browse(`/github/oauth/callback?code=good-code&state=${forgedState}`);
    expect(rejected.status).toBe(403);
    expect(store.getInstallation(999)).toBeUndefined();

    const install = await browse('/github/install');
    expect(install.status).toBe(302);
    const installUrl = new URL(install.headers.get('location')!);
    expect(installUrl.pathname).toBe('/apps/lexc-test/installations/new');
    const setup = await browse(`/github/setup?installation_id=${INSTALLATION}&setup_action=install&state=${installUrl.searchParams.get('state')}`);
    const authorize = new URL(setup.headers.get('location')!);
    expect(authorize.pathname).toBe('/login/oauth/authorize');
    // State is bound to the person who started the flow.
    expect((await browse(`/github/oauth/callback?code=good-code&state=${authorize.searchParams.get('state')}`, 'mallory')).status).toBe(400);
    const setup2 = await browse(`/github/setup?installation_id=${INSTALLATION}&setup_action=install`);
    const done = await browse(`/github/oauth/callback?code=good-code&state=${new URL(setup2.headers.get('location')!).searchParams.get('state')}`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('acme/core-platform');
    expect(store.getRepoByGithubId(REPO_ID)).toMatchObject({ workspaceId, defaultBranch: 'main' });
  });

  it('scans the default branch as the baseline, without blocking', async () => {
    expect(await queue.drain()).toBe(1);
    const run = lastRun();
    expect(run.create).toMatchObject({ head_sha: BASE, status: 'in_progress' });
    const patch = finalPatch(run);
    expect(patch.conclusion).toBe('neutral');
    expect(patch.output.title).toBe('6 findings on main (baseline for pull requests)');
    expect(fake.tarballRequests).toEqual([BASE]);
  });

  it('fails a pull request only for the findings it adds', async () => {
    await deliver('pull_request', prPayload('opened', HEAD1));
    expect(await queue.drain()).toBe(1);
    const patch = finalPatch();
    expect(patch.conclusion).toBe('failure');
    expect(patch.output.title).toBe('2 new findings (R-1, R-2)');
    const failures = patch.output.annotations.filter((a) => a.annotation_level === 'failure');
    expect(failures.map((a) => [a.path, a.start_line, a.title.slice(0, 3)])).toEqual([
      ['api/loan_applications.py', 20, 'R-1'],
      ['api/loan_applications.py', 21, 'R-2'],
    ]);
    expect(patch.output.annotations.filter((a) => a.annotation_level === 'warning')).toHaveLength(6);
    // The baseline was reused from the default-branch scan, not downloaded again.
    expect(fake.tarballRequests).toEqual([BASE, HEAD1]);
    expect(lastRun().create.details_url).toMatch(/^http:\/\/lexc\.test\/app\/checks\/[0-9a-f-]{36}$/);
    // The run names the signed evidence record of this scan (guide, Phase 5 test, step 5).
    const scanId = String(lastRun().create.details_url).split('/').pop()!;
    const ev = store.scanEvidence(scanId)!;
    expect((patch as unknown as { output: { summary: string } }).output.summary).toContain(`Evidence record #${ev.seq} · header SHA-256 \`${ev.headerSha256}\``);
    const record = evidenceLog.records(workspaceId).find((r) => r.seq === ev.seq)!;
    expect(JSON.parse(record.body)).toMatchObject({ scanId, pullRequest: 5, commit: HEAD1, conclusion: 'failure', results: expect.arrayContaining([expect.objectContaining({ ruleKey: 'R-1', new: [expect.any(String)] })]) });
    expect(verifyRecords(evidenceLog.records(workspaceId), await evidenceLog.publicKeys(workspaceId, [], new Map()))).toEqual([]);
  });

  it('re-checks a pushed fix and a re-run request', async () => {
    await deliver('pull_request', prPayload('synchronize', HEAD2));
    await queue.drain();
    expect(finalPatch()).toMatchObject({ conclusion: 'failure', output: { title: '1 new finding (R-1)' } });

    const runs = fake.checkRuns.length;
    await deliver('check_run', { action: 'rerequested', repository, check_run: { app: { id: Number(APP_ID) }, head_sha: HEAD2, pull_requests: [{ number: 5, base: { sha: BASE } }] } });
    // Another app's check run is not ours to re-run.
    await deliver('check_run', { action: 'rerequested', repository, check_run: { app: { id: 999 }, head_sha: HEAD2, pull_requests: [] } });
    expect(await queue.drain()).toBe(1);
    expect(fake.checkRuns.length).toBe(runs + 1);
    expect(finalPatch().output.title).toBe('1 new finding (R-1)');
  });

  it('requests an exception from the check run button; approval turns the check green until it expires', async () => {
    // PR #5 at HEAD2 still fails for R-1 on line 20 and offers the button.
    const failing = lastRun();
    expect(finalPatch(failing)).toMatchObject({ conclusion: 'failure', actions: [{ label: 'Request exception', identifier: 'request_exception' }] });
    const click = () =>
      deliver('check_run', {
        action: 'requested_action',
        repository,
        sender: { login: 'tanvir' },
        requested_action: { identifier: 'request_exception' },
        check_run: { id: failing.id, app: { id: Number(APP_ID) }, head_sha: HEAD2, pull_requests: [{ number: 5, base: { sha: BASE } }] },
      });
    expect((await click()).body.result).toBe('exception requested for 1 finding');
    expect(await queue.drain()).toBe(1);
    expect(fake.comments.at(-1)).toEqual({ issue: 5, body: expect.stringContaining('Exception requested by @tanvir — waiting for Legal') });
    expect(fake.comments.at(-1)!.body).toContain('**R-1** `api/loan_applications.py:20`');
    // A second click adds nothing.
    expect((await click()).body.result).toBe('exception already requested');
    expect(await queue.drain()).toBe(0);

    const [request] = store.listExceptions(workspaceId, { status: 'requested' });
    expect(request).toMatchObject({ ruleKey: 'R-1', requestedBy: 'github:tanvir', requestedFrom: 'github', prNumber: 5, headSha: HEAD2, filePath: 'api/loan_applications.py', startLine: 20 });
    // Approval needs a reason and an end date.
    const nusrat = store.upsertUser({ sub: 'nusrat' }).id;
    expect(() => store.decideException(workspaceId, request.id, nusrat, { approve: true, note: '', expiresAt: '2099-01-01' })).toThrow('reason');
    expect(() => store.decideException(workspaceId, request.id, nusrat, { approve: true, note: 'ok', expiresAt: '2000-01-01' })).toThrow('future');
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const approved = store.decideException(workspaceId, request.id, nusrat, { approve: true, note: 'Endpoint does not store PII; storage is added in LN-12', expiresAt: until.toISOString() });
    const runs = fake.checkRuns.length;
    expect(rerunCheckForException({ store, queue }, approved)).not.toBeNull();
    expect(await queue.drain()).toBe(1);
    expect(fake.checkRuns.length).toBe(runs + 1);
    const green = finalPatch() as ReturnType<typeof finalPatch> & { actions?: unknown; output: { summary: string } };
    expect(green.conclusion).toBe('success');
    expect(green.actions).toBeUndefined();
    const day = until.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    expect(green.output.summary).toContain(`1 finding waived until ${day}`);
    expect(green.output.annotations.find((a) => a.path === 'api/loan_applications.py')?.annotation_level).toBe('notice');

    // Expiry (the guide's test-only admin action): the next check fails again.
    store.setExceptionExpiry(workspaceId, request.id, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    expect(store.expireExceptions()).toBe(1);
    expect(store.getException(workspaceId, request.id)?.status).toBe('expired');
    await deliver('pull_request', prPayload('synchronize', HEAD2));
    expect(await queue.drain()).toBe(1);
    expect(finalPatch()).toMatchObject({ conclusion: 'failure', output: { title: '1 new finding (R-1)' } });
  });

  it('ignores pushes to other branches and branch deletions', async () => {
    expect((await deliver('push', { ref: 'refs/heads/feature', after: HEAD1, repository })).body.result).toBe('ignored: not the default branch');
    expect((await deliver('push', { ref: 'refs/heads/main', after: '0'.repeat(40), deleted: true, repository })).body.result).toBe('ignored: branch deleted');
    expect(await queue.drain()).toBe(0);
  });

  it('links check runs to the web app and shows a scan only to members of its workspace', async () => {
    const url = new URL(String(lastRun().create.details_url));
    const scanId = url.pathname.split('/').pop()!;
    expect(url.pathname).toBe(`/app/checks/${scanId}`);
    // The server-rendered page (what older check runs link to) is member-checked and points to the web app.
    const page = await browse(`/scans/${scanId}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('api/loan_applications.py:20');
    expect(html).toContain(`/app/checks/${scanId}`);
    expect((await browse(`/scans/${scanId}`, 'stranger')).status).toBe(404);
  });

  it('retries a dropped download inside one attempt', async () => {
    fake.dropTarball.set(HEAD4, 1);
    const before = fake.tarballRequests.length;
    expect(queue.enqueue('scan', { githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'pull_request', trigger: 'pull_request', headSha: HEAD4, baseSha: BASE, prNumber: 7 })).not.toBeNull();
    expect(await queue.drain()).toBe(1);
    expect(fake.tarballRequests.slice(before)).toEqual([HEAD4, HEAD4]);
    const runs = fake.checkRuns.filter((r) => r.create.head_sha === HEAD4);
    expect(runs).toHaveLength(1);
    expect(finalPatch(runs[0])).toMatchObject({ conclusion: 'failure', output: { title: '1 new finding (R-1)' } });
  });

  it('keeps one check run when a job fails and retries', async () => {
    // Four drops outlast the client's retries, so attempt 1 fails; attempt 2 gets the archive.
    fake.dropTarball.set(HEAD3, 4);
    const retrying = new JobQueue(store.db, { scan: createScanJobHandler({ store, getApp, publicUrl: 'http://lexc.test' }) }, { maxAttempts: 2, backoffMs: () => 0 });
    retrying.enqueue('scan', { githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'pull_request', trigger: 'pull_request', headSha: HEAD3, baseSha: BASE, prNumber: 6 });
    expect(await retrying.drain()).toBe(2);
    const runs = fake.checkRuns.filter((r) => r.create.head_sha === HEAD3);
    expect(runs).toHaveLength(1);
    const [retryNote, reopened, final] = runs[0].patches as Array<{ status?: string; conclusion?: string; output?: { title: string } }>;
    expect(retryNote.status).toBeUndefined();
    expect(retryNote.output?.title).toMatch(/^Retrying/);
    expect(reopened.status).toBe('in_progress');
    expect(final).toMatchObject({ status: 'completed', conclusion: 'failure', output: { title: '1 new finding (R-1)' } });
    const scans = store.db.prepare('SELECT status, check_run_id, job_id FROM scans WHERE commit_sha = ? ORDER BY created_at').all(HEAD3) as Array<{ status: string; check_run_id: number; job_id: string }>;
    expect(scans.map((x) => x.status)).toEqual(['failed', 'completed']);
    expect(new Set(scans.map((x) => x.check_run_id)).size).toBe(1);
    expect(new Set(scans.map((x) => x.job_id)).size).toBe(1);
  });

  it('warns on pull requests about a version that takes effect later, and lists it as coming up from main', async () => {
    // R-3 v2: human review below 0.92 instead of 0.85, effective in 3 days (guide, scene 6).
    const r3 = store.rulesInEffect(workspaceId).find((r) => r.clause.category === 'AI_HUMAN_IN_THE_LOOP')!;
    const text = r3.clause.rawLegalText.replace(/0\.85/g, '0.92').replace(/85%/g, '92%');
    const clause = compileClauseSync({ text, key: r3.ruleKey, title: r3.clause.title, citation: r3.clause.citation, category: r3.clause.category });
    expect(clause.deontic.extractedParameters.minAiConfidenceThreshold).toBe(0.92);
    const arif = store.getUserBySub('arif')!;
    const { version } = store.createRuleDraft({ workspaceId, ruleId: r3.ruleId, title: r3.clause.title, sourceText: text, clause, createdBy: arif.id });
    const effective = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    store.approveRuleVersion(workspaceId, version.id, arif.id, { effectiveFrom: effective.toISOString() });
    const date = effective.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

    // A push to main refreshes "Coming up" from the files of that commit.
    queue.enqueue('scan', { githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'push', trigger: 'push', headSha: BASE });
    await queue.drain();
    const coming = store.listComingUp(workspaceId).filter((c) => c.versionId === version.id);
    expect(coming).toHaveLength(1);
    expect(coming[0].commitSha).toBe(BASE);
    expect(coming[0].findings.map((f) => f.filePath)).toContain('services/ai_credit_triage.ts');

    // A pull request keeps its conclusion and shows the future failures as warnings.
    queue.enqueue('scan', { githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'pull_request', trigger: 'pull_request', headSha: HEAD2, baseSha: BASE, prNumber: 8 });
    await queue.drain();
    const patch = finalPatch() as ReturnType<typeof finalPatch> & { output: { summary: string; annotations: Array<{ title: string; annotation_level: string; path: string }> } };
    // Same answer as without the future version: R-1 is still the only new finding.
    expect(patch.conclusion).toBe('failure');
    expect(patch.output.title).toBe('1 new finding (R-1)');
    expect(patch.output.summary).toContain('### Coming up');
    expect(patch.output.summary).toContain(`**${r3.ruleKey} v${version.version}** takes effect on ${date}`);
    expect(patch.output.annotations.filter((a) => a.title.startsWith(`${r3.ruleKey} v${version.version} · from`)).map((a) => [a.path, a.annotation_level])).toContainEqual(['services/ai_credit_triage.ts', 'warning']);
  });

  it('says which permission to change when the App can only read contents', async () => {
    fake.flags.readOnlyContents = true;
    try {
      await expect(openFixPullRequest({ store, app: getApp() }, store.getRepoByGithubId(REPO_ID)!, 'arif@example.test')).rejects.toThrow(/Contents to "Read and write"/);
      expect(fake.pulls).toHaveLength(0);
    } finally {
      fake.flags.readOnlyContents = false;
    }
  });

  it('scene 3: opens one verified fix pull request for main, as a single commit, once per base commit', async () => {
    const repo = store.getRepoByGithubId(REPO_ID)!;
    const first = await openFixPullRequest({ store, app: getApp() }, repo, 'arif@example.test');
    expect(first).toMatchObject({ created: true, prNumber: 101, branch: `lexcompiler/fix-${BASE.slice(0, 7)}`, baseSha: BASE });
    // One commit on the base commit's tree, with one blob per patched file.
    expect(fake.commits).toHaveLength(1);
    expect(fake.commits[0]).toMatchObject({ parents: [BASE], tree: 'tree-new-1' });
    expect(String(fake.commits[0].message)).toContain('Z3 proves each rule after this change (SAT_COMPLIANT)');
    const tree = fake.trees[0] as { base_tree: string; tree: Array<{ path: string; sha: string }> };
    expect(tree.base_tree).toBe(`tree-${BASE}`);
    expect(tree.tree.map((t) => t.path).sort()).toEqual([...first.files].sort());
    expect(first.files.length).toBeGreaterThanOrEqual(3);
    for (const t of tree.tree) expect(fake.blobs.get(t.sha)).not.toBe(fixture[t.path]);
    expect(fake.refs.get(`refs/heads/${first.branch}`)).toBe(first.commitSha);
    expect(fake.pulls[0]).toMatchObject({ head: first.branch, base: 'main' });
    expect(String(fake.pulls[0].body)).toContain('Requested by arif@example.test');

    // The patched files pass every rule in effect.
    const patched = Object.fromEntries(tree.tree.map((t) => [t.path, fake.blobs.get(t.sha)!]));
    const files = Object.entries({ ...fixture, 'api/privacy.py': PRIVACY, ...patched }).map(([p, content]) => ({ path: p, language: (p.endsWith('.sql') ? 'sql' : p.endsWith('.ts') ? 'typescript' : 'python') as 'sql' | 'typescript' | 'python', description: '', content, lastModified: '' }));
    const after = await scanFiles(files, store.rulesInEffect(workspaceId));
    expect(after.findings.filter((f) => first.addressed.includes(f.ruleKey))).toEqual([]);

    // Asking again for the same main commit returns the same pull request.
    expect(await openFixPullRequest({ store, app: getApp() }, repo, 'arif@example.test')).toMatchObject({ created: false, prNumber: 101 });
    expect(fake.pulls).toHaveLength(1);
  });

  it('scene 4: suggests the redact_pii fix on the changed line, once per finding', async () => {
    // Tanvir's PR adds the loan endpoint: every line of the file is in the diff.
    fake.prFiles.set(9, [{ filename: 'api/loan_applications.py', patch: `@@ -0,0 +1,${LOANS.split('\n').length - 1} @@\n${LOANS.split('\n').slice(0, -1).map((l) => `+${l}`).join('\n')}` }]);
    const reviewsBefore = fake.reviews.length;
    queue.enqueue('scan', { githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'pull_request', trigger: 'pull_request', headSha: HEAD1, baseSha: BASE, prNumber: 9 });
    await queue.drain();
    expect(fake.reviews.length).toBe(reviewsBefore + 1);
    const review = fake.reviews.at(-1)!;
    expect(review.pr).toBe(9);
    expect(review.body).toMatchObject({ commit_id: HEAD1, event: 'COMMENT' });
    const comments = review.body.comments as Array<{ path: string; line: number; side: string; body: string }>;
    const r2 = comments.find((c) => c.body.startsWith('**R-2**'))!;
    expect(r2).toMatchObject({ path: 'api/loan_applications.py', line: 21, side: 'RIGHT' });
    expect(r2.body).toMatch(/```suggestion\n.*redact_pii\(applicant\.phone\).*\n```/s);
    // R-1 needs a tenant KMS client added elsewhere in the file: no one-line suggestion, the annotation stays.
    expect(comments.some((c) => c.body.startsWith('**R-1**'))).toBe(false);

    // A new push to the same PR doesn't repeat the comment.
    queue.enqueue('scan', { githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'pull_request', trigger: 'pull_request', headSha: HEAD1, baseSha: BASE, prNumber: 9 });
    await queue.drain();
    expect(fake.reviews.length).toBe(reviewsBefore + 1);
  });

  it('adds AI explanations after the check, citing only retrieved text, without changing the result', async () => {
    // A fake OpenAI-compatible model: cites the first two chunk ids it was given, and one made up.
    const llm = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const user = (JSON.parse(raw).messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;
        const ids = [...user.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
        const answer = { explanation: `The rule forbids this [${ids[0]}]. The code at the cited lines does it anyway [${ids[1]}], see also [made:up].`, citations: [ids[0], ids[1], 'made:up'] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
      });
    });
    await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
    try {
      const env = { LEXCOMPILER_LLM_PROVIDER: 'openai', LEXCOMPILER_LLM_MODEL: 'fake-cloud', LEXCOMPILER_LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, LEXCOMPILER_LLM_API_KEY: 'test' };
      const ai = new AiGateway(store.db, { env });
      ai.setSettings(workspaceId, { mode: 'cloud' }, 'owner');
      // The handler runs directly, not through the shared jobs table, so no other queue can pick the job up.
      const withAi = createScanJobHandler({ store, getApp, publicUrl: 'http://lexc.test', ai });
      fake.prFiles.set(10, [{ filename: 'api/loan_applications.py', patch: `@@ -0,0 +1,${LOANS.split('\n').length - 1} @@\n${LOANS.split('\n').slice(0, -1).map((l) => `+${l}`).join('\n')}` }]);
      await withAi({ githubRepoId: REPO_ID, installationId: INSTALLATION, kind: 'pull_request', trigger: 'pull_request', headSha: HEAD1, baseSha: BASE, prNumber: 10 }, { jobId: 'ai-test', attempt: 1, maxAttempts: 1 });

      // This PR's run (the queue shares the jobs table, so it may also have run an older job).
      const scan = store.listScans(workspaceId).find((x) => x.prNumber === 10)!;
      expect(scan).toMatchObject({ status: 'completed' });
      const run = fake.checkRuns[scan.checkRunId! - 1];
      // The result is the same as without AI, and it was final before any model ran.
      const completedAt = run.patches.findIndex((p) => p.status === 'completed');
      expect(finalPatch(run)).toMatchObject({ conclusion: 'failure', output: { title: '2 new findings (R-1, R-2)' } });
      const details = run.patches.findIndex((p) => typeof (p.output as { text?: string } | undefined)?.text === 'string');
      expect(details).toBeGreaterThan(completedAt);
      const text = (run.patches[details].output as { text: string }).text;
      expect(text).toContain('## AI explanations');
      expect(text).toContain('Written by fake-cloud');
      expect(text).toContain('### R-2 · `api/loan_applications.py:21`');
      expect(text).toContain('[rule:R-2]');
      expect(text).not.toContain('made:up');
      // The suggestion comment carries the explanation too.
      const comment = (fake.reviews.filter((r) => r.pr === 10).at(-1)!.body.comments as Array<{ body: string }>).find((c) => c.body.startsWith('**R-2**'))!;
      expect(comment.body).toContain('**AI explanation** (fake-cloud):');
      // Every call is logged as an explanation, with the prompt's hash only.
      const calls = ai.listCalls(workspaceId).filter((c) => c.task === 'explanation');
      expect(calls.length).toBe(2);
      expect(calls[0]).toMatchObject({ model: 'fake-cloud', outcome: 'ok' });
      ai.setSettings(workspaceId, { mode: 'off' }, 'owner');
    } finally {
      llm.close();
    }
  });

  it('maps scan summaries to check conclusions', () => {
    const s = { newCount: 0, existingCount: 3, waivedCount: 0, undecidedRuleKeys: [] as string[], perRule: [] };
    expect(checkConclusion('pull_request', s)).toBe('success');
    expect(checkConclusion('pull_request', { ...s, undecidedRuleKeys: ['R-3'] })).toBe('action_required');
    expect(checkConclusion('push', s)).toBe('neutral');
    expect(checkConclusion('push', { ...s, existingCount: 0 })).toBe('success');
  });
});
