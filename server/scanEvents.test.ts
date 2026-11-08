import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import type { OutboundDeps } from './events/outbound.js';
import type { JobQueue } from './jobs/queue.js';
import { compileClauseSync } from './product/clauses.js';
import { runNightlyScans, scanLocalRepo } from './product/repoScan.js';
import { ProductStore, type Repo } from './product/store.js';

/**
 * The `scan.completed` emit points: a scan that finishes through scanLocalRepo (the API route,
 * the MCP tools and the nightly job all share it) queues one signed event per workspace webhook
 * that subscribed to it. Exception and regulation-watch emit points live in flowEvents.test.ts
 * and regulationWatch.test.ts; the delivery pipeline itself is covered in outboundEvents.test.ts.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-scan-events-'));
const reposRoot = path.join(dataDir, 'repos');

interface QueuedEvent {
  kind: string;
  payload: { event: { id: string; type: string; workspaceId: string; data: Record<string, unknown> } };
}

/** A workspace with an approved HIPAA logging rule, the fixture repo, a webhook and a queue that records. */
function setup(events: string[] = ['scan.completed']) {
  const store = new ProductStore(openDatabase(':memory:'));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  const ws = store.createWorkspace('FinHealth AI', arif.id).id;
  const c = getInitialClauses().find((x) => x.category === 'PII_LOGGING_BAN')!;
  const clause = compileClauseSync({ text: c.rawLegalText, key: store.nextRuleKey(ws), title: c.title, citation: c.citation, category: c.category });
  const { version } = store.createRuleDraft({ workspaceId: ws, title: c.title, sourceText: c.rawLegalText, clause, createdBy: arif.id });
  store.approveRuleVersion(ws, version.id, arif.id);
  const repo = store.addLocalRepo(ws, 'acme/core-platform', path.join(reposRoot, 'core-platform'));
  store.setWorkspaceWebhook(ws, { url: 'https://hooks.example.test/x', events });
  const queued: QueuedEvent[] = [];
  const queue = { enqueue: (kind: string, payload: never) => (queued.push({ kind, payload }), `job-${queued.length}`) } as unknown as JobQueue;
  const outbound: OutboundDeps = { store, queue, publicUrl: 'http://lexc.test' };
  return { store, ws, repo, outbound, queued };
}

beforeAll(() => {
  for (const [rel, spec] of Object.entries(INITIAL_REPO_FILES)) {
    const p = path.join(reposRoot, 'core-platform', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, spec.content);
  }
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('scan.completed events', () => {
  it('queues one scan.completed event when a local repository scan finishes', async () => {
    const { store, ws, repo, outbound, queued } = setup();
    const { scan, findings } = await scanLocalRepo({ store, events: outbound }, repo, 'manual');
    // The fixture's intake endpoint logs ssn, email and diagnosis_code: the rule finds them.
    expect(findings.length).toBeGreaterThan(0);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('event_delivery');
    const event = queued[0].payload.event;
    expect(event).toMatchObject({ type: 'scan.completed', workspaceId: ws });
    expect(event.data).toMatchObject({
      repository: 'acme/core-platform',
      commit: 'working-tree',
      trigger: 'manual',
      conclusion: scan.conclusion,
      filesScanned: scan.filesScanned,
      findingsTotal: findings.length,
      url: `http://lexc.test/app/checks/${scan.id}`,
    });
    const counts = event.data.counts as { new: number; existing: number; waived: number };
    expect(counts.existing).toBeGreaterThan(0); // no base branch: first-scan findings are 'existing'
    expect(counts.new + counts.existing + counts.waived).toBe(findings.length);
    // The delivery is recorded as pending until the job runs.
    expect(store.listOutboundDeliveries(ws)).toMatchObject([{ eventId: event.id, eventType: 'scan.completed', status: 'pending', attempts: 0 }]);
  });

  it('queues nothing when the webhook is not subscribed to scan.completed', async () => {
    const { store, repo, outbound, queued } = setup(['exception.decided']);
    await scanLocalRepo({ store, events: outbound }, repo, 'manual');
    expect(queued).toHaveLength(0);
    expect(store.listOutboundDeliveries(repo.workspaceId!)).toHaveLength(0);
  });

  it('emits scan.completed for local repositories during the nightly run', async () => {
    const { store, outbound, queued } = setup();
    const githubQueued: string[] = [];
    const deps = { store, events: outbound, enqueueGithubScan: (r: Repo, key: string) => (githubQueued.push(`${r.fullName} ${key}`), `job-${githubQueued.length}`) };
    const result = await runNightlyScans(deps, new Date('2026-12-01T03:00:00Z'));
    expect(result).toEqual({ local: 1, queued: 0, failed: [] });
    expect(queued.map((q) => q.payload.event.type)).toEqual(['scan.completed']);
    expect(queued[0].payload.event.data).toMatchObject({ repository: 'acme/core-platform', trigger: 'scheduled' });
  });

  it('does not fail the scan when the queue throws', async () => {
    const { store, ws, repo } = setup();
    const broken = { enqueue: () => { throw new Error('boom'); } } as unknown as JobQueue;
    const { scan } = await scanLocalRepo({ store, events: { store, queue: broken } }, repo, 'manual');
    expect(scan.status).toBe('completed');
    expect(store.listOutboundDeliveries(ws)).toHaveLength(1);
  });
});
