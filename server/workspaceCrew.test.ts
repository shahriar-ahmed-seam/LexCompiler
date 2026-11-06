import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES, readRepositoryFilesAt } from './analyzer/repoBaseline.js';
import { CrewRunStore, type CrewPullRequest, type CallTool, runCrew } from './agents/crew.js';
import { runWorkspaceCrew } from './agents/workspaceCrew.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { executeMcpTool } from './mcp/mcpSuite.js';
import { compileClauseSync } from './product/clauses.js';
import { createProductRouter } from './product/router.js';
import { ProductStore, type Repo } from './product/store.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-crew-'));
let store: ProductStore;
let runs: CrewRunStore;
let ws: string;
let other: string;
let local: Repo;
let github: Repo;
let server: http.Server;
let origin = '';
const prCalls: Array<{ repo: string; by: string }> = [];
let prResult: () => Promise<CrewPullRequest> = async () => ({ created: true, prNumber: 7, url: 'https://github.test/acme/core/pull/7' });
const toolFiles: Array<string[] | undefined> = [];

/** The real tools with a fixed feed (one retention notice); records which files each tool read. */
const callTool: CallTool = async (server, tool, args, clauses, files) => {
  toolFiles.push(files?.map((f) => f.path));
  if (tool === 'fetch_live_regulatory_feed') {
    const retention = getInitialClauses().find((c) => c.category === 'RETENTION_AND_TENANT_KMS')!;
    return { items: [{ id: 'FEED-1', title: 'Retention notice', excerpt: retention.rawLegalText }] };
  }
  return executeMcpTool(server, tool, args, clauses, files);
};

beforeAll(async () => {
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  runs = new CrewRunStore(store.db);
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true, name: 'Arif' });
  ws = store.createWorkspace('FinHealth AI', arif.id).id;
  store.invite(ws, 'viewer@example.test', 'viewer', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'vera', email: 'viewer@example.test', emailVerified: true, name: 'Vera' }));
  const eve = store.upsertUser({ sub: 'eve', email: 'eve@example.test', emailVerified: true, name: 'Eve' });
  other = store.createWorkspace('Other Co', eve.id).id;

  // Two approved rules: retention (the feed touches it) and the PII logging ban.
  for (const builtin of getInitialClauses().filter((c) => ['RETENTION_AND_TENANT_KMS', 'PII_LOGGING_BAN'].includes(c.category))) {
    const key = store.nextRuleKey(ws);
    const clause = compileClauseSync({ text: builtin.rawLegalText, key, title: builtin.title, citation: builtin.citation, category: builtin.category, frameworkId: builtin.frameworkId });
    const { version } = store.createRuleDraft({ workspaceId: ws, title: builtin.title, sourceText: builtin.rawLegalText, clause, createdBy: arif.id });
    store.approveRuleVersion(ws, version.id, arif.id, { note: 'test' });
  }

  const root = path.join(dataDir, 'core-platform');
  for (const [rel, spec] of Object.entries(INITIAL_REPO_FILES)) {
    if (rel.startsWith('services/')) continue; // a smaller repository than the bundled one
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), spec.content);
  }
  local = store.addLocalRepo(ws, 'acme/core-platform', root);
  store.upsertInstallation({ installationId: 99, accountLogin: 'acme', accountType: 'Organization' });
  github = store.upsertGithubRepo({ installationId: 99, githubRepoId: 4242, fullName: 'acme/core', defaultBranch: 'main' });
  store.linkInstallation(99, ws);
  github = store.getRepo(github.id)!;

  const deps = {
    store,
    runs,
    readHead: async (repo: Repo) => ({ commitSha: repo.source === 'local' ? 'working-tree' : 'abc1234', files: readRepositoryFilesAt(root) }),
    openFixPr: async (repo: Repo, by: string) => {
      prCalls.push({ repo: repo.fullName, by });
      return prResult();
    },
    runCrew: ((clauses, opts) => runCrew(clauses, { ...opts, callTool })) as typeof runCrew,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const sub = req.header('x-test-user');
    res.locals.principal = sub ? { sub, globalRole: sub === 'root' ? 'admin' : 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use('/api', createProductRouter(store, null, { reposRoot: dataDir, crew: { runs, run: (repo, opts) => runWorkspaceCrew(deps, repo, opts) } }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (p: string, user: string, body?: unknown) => {
  const res = await fetch(`${origin}/api${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

describe('the crew on a workspace repository', () => {
  it('checks the repository’s own files against the workspace’s rules in effect', async () => {
    toolFiles.length = 0;
    const r = await call(`/workspaces/${ws}/repos/${local.id}/crew-runs`, 'arif', {});
    expect(r.status).toBe(201);
    const run = r.json;
    expect(run.target).toEqual({ workspaceId: ws, repoId: local.id, repoFullName: 'acme/core-platform', commitSha: 'working-tree' });
    // The workspace's rule keys, not the bundled clause ids; only the rule the feed touched goes on.
    expect(run.steps[0].received.activeClauses.map((c: { id: string }) => c.id)).toEqual(['R-1', 'R-2']);
    expect(run.steps[0].handoff.clauseIds).toEqual(['R-1']);
    // Every repository tool read this repository, which has no services/ folder.
    const read = toolFiles.filter((f): f is string[] => Boolean(f));
    expect(read.length).toBeGreaterThanOrEqual(4);
    for (const files of read) expect(files.some((f) => f.startsWith('services/'))).toBe(false);
    expect(run.gate).toBe('PATCH_VERIFIED');
    expect(run.steps[5].handoff.pullRequest).toBeUndefined();
    expect(prCalls).toHaveLength(0);
  });

  it('opens a pull request for a verified patch on a GitHub repository, when asked', async () => {
    const r = await call(`/workspaces/${ws}/repos/${github.id}/crew-runs`, 'arif', { openPullRequest: true });
    expect(r.status).toBe(201);
    expect(r.json.target.commitSha).toBe('abc1234');
    expect(r.json.steps[5].handoff.pullRequest).toEqual({ created: true, prNumber: 7, url: 'https://github.test/acme/core/pull/7' });
    expect(r.json.steps[5].summary).toMatch(/Opened pull request #7/);
    expect(prCalls).toEqual([{ repo: 'acme/core', by: 'arif@example.test' }]);
  });

  it('records why no pull request was opened', async () => {
    prResult = async () => {
      throw new Error('No verified fix: the patch did not pass the Z3 gate');
    };
    const r = await call(`/workspaces/${ws}/repos/${github.id}/crew-runs`, 'arif', { openPullRequest: true });
    expect(r.status).toBe(201);
    expect(r.json.steps[5].handoff.pullRequestError).toMatch(/did not pass the Z3 gate/);
    expect(r.json.gate).toBe('PATCH_VERIFIED');
  });

  it('refuses what the caller may not do', async () => {
    expect((await call(`/workspaces/${ws}/repos/${local.id}/crew-runs`, 'arif', { openPullRequest: true })).json.error).toMatch(/opened on GitHub repositories/);
    expect((await call(`/workspaces/${ws}/repos/${local.id}/crew-runs`, 'arif', { useModels: true })).status).toBe(403);
    expect((await call(`/workspaces/${ws}/repos/${local.id}/crew-runs`, 'vera', {})).status).toBe(403);
    expect((await call(`/workspaces/${ws}/repos/${local.id}/crew-runs`, 'eve', {})).status).toBe(404);
    expect((await call(`/workspaces/${other}/repos/${local.id}/crew-runs`, 'eve', {})).status).toBe(404);
  });

  it('lists a workspace’s runs to its members only', async () => {
    const list = await call(`/workspaces/${ws}/crew-runs`, 'vera');
    expect(list.status).toBe(200);
    expect(list.json.runs).toHaveLength(3);
    const id = list.json.runs[0].id;
    expect((await call(`/workspaces/${ws}/crew-runs/${id}`, 'vera')).json.steps).toHaveLength(6);
    expect((await call(`/workspaces/${other}/crew-runs`, 'eve')).json.runs).toEqual([]);
    expect((await call(`/workspaces/${other}/crew-runs/${id}`, 'eve')).status).toBe(404);
    expect((await call(`/workspaces/${ws}/crew-runs`, 'eve')).status).toBe(404);
    // Runs on the bundled repository are kept apart from workspace runs.
    expect(runs.list(null)).toEqual([]);
  });
});
