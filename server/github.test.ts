import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { importSPKI, jwtVerify } from 'jose';
import { create as createTar } from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { checkConclusion } from './github/checkRun.js';
import { GitHubApp, verifyWebhookSignature } from './github/client.js';
import { createGitHubRoutes, type BrowserAuth } from './github/routes.js';
import { createScanJobHandler } from './github/scanJob.js';
import { readTarballSources } from './github/tarball.js';
import { createWebhookHandler } from './github/webhooks.js';
import { JobQueue } from './jobs/queue.js';
import { compileClauseSync } from './product/clauses.js';
import { ProductStore } from './product/store.js';

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

async function targz(files: Record<string, string>, root: string, extra?: (dir: string) => void): Promise<Buffer> {
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
      const stream = createTar({ gzip: true, cwd: dir, portable: true }, [root]);
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return Buffer.concat(chunks);
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
  return { server, base, archives, dropTarball, tarballRequests, checkRuns };
}

let fake: Awaited<ReturnType<typeof startFakeGitHub>>;
let api: http.Server;
let lex: string;
let store: ProductStore;
let queue: JobQueue;
let workspaceId: string;
let getApp: () => GitHubApp;
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
  queue = new JobQueue(db, { scan: createScanJobHandler({ store, getApp, publicUrl }) }, { maxAttempts: 1 });
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

describe('GitHub App', () => {
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
    const archive = await targz({ 'api/app.py': 'x = 1\n', 'node_modules/pkg/evil.py': 'x = 2\n', '.github/hidden.py': 'x = 3\n', 'types.d.ts': 'export {}\n', 'README.md': '# hi' }, 'acme-repo-abc1234', (root) => {
      fs.symlinkSync('/etc/passwd', path.join(root, 'api', 'link.py'));
      fs.writeFileSync(path.join(root, 'api', 'big.py'), 'x = 1\n'.repeat(200_000));
    });
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

  it('ignores pushes to other branches and branch deletions', async () => {
    expect((await deliver('push', { ref: 'refs/heads/feature', after: HEAD1, repository })).body.result).toBe('ignored: not the default branch');
    expect((await deliver('push', { ref: 'refs/heads/main', after: '0'.repeat(40), deleted: true, repository })).body.result).toBe('ignored: branch deleted');
    expect(await queue.drain()).toBe(0);
  });

  it('links check runs to the scan page in the web app', async () => {
    const url = new URL(String(lastRun().create.details_url));
    const scanId = url.pathname.split('/').pop()!;
    expect(url.pathname).toBe(`/app/checks/${scanId}`);
    // Older check runs link to /scans/<id>, which now redirects there. Access is checked by the API.
    const old = await browse(`/scans/${scanId}`);
    expect(old.status).toBe(302);
    expect(old.headers.get('location')).toBe(`/app/checks/${scanId}`);
    expect(store.listFindings(scanId).some((f) => f.filePath === 'api/loan_applications.py' && f.startLine === 20)).toBe(true);
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

  it('maps scan summaries to check conclusions', () => {
    const s = { newCount: 0, existingCount: 3, waivedCount: 0, undecidedRuleKeys: [] as string[], perRule: [] };
    expect(checkConclusion('pull_request', s)).toBe('success');
    expect(checkConclusion('pull_request', { ...s, undecidedRuleKeys: ['R-3'] })).toBe('action_required');
    expect(checkConclusion('push', s)).toBe('neutral');
    expect(checkConclusion('push', { ...s, existingCount: 0 })).toBe('success');
  });
});
