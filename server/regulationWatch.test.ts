import { describe, expect, it } from 'vitest';
import type { AiGateway, CompleteRequest, CompleteResult } from './ai/gateway.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { compileClauseSync } from './product/clauses.js';
import { runDueJobs } from './product/feed.js';
import type { JobQueue } from './jobs/queue.js';
import { watchRegulationFeed } from './product/regulationWatch.js';
import { ProductStore } from './product/store.js';

const RETENTION = getInitialClauses().find((c) => c.category === 'RETENTION_AND_TENANT_KMS')!;

function setup() {
  const store = new ProductStore(openDatabase(':memory:'));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  const ws = store.createWorkspace('FinHealth AI', arif.id).id;
  for (const c of getInitialClauses().filter((x) => ['RETENTION_AND_TENANT_KMS', 'PII_LOGGING_BAN'].includes(x.category))) {
    const key = store.nextRuleKey(ws);
    const clause = compileClauseSync({ text: c.rawLegalText, key, title: c.title, citation: c.citation, category: c.category });
    const { version } = store.createRuleDraft({ workspaceId: ws, title: c.title, sourceText: c.rawLegalText, clause, createdBy: arif.id });
    store.approveRuleVersion(ws, version.id, arif.id);
  }
  const item = (n: number, title: string, excerpt: string, kind: 'TEXT' | 'CHANGE_NOTICE' = 'TEXT') => ({
    id: `FEDERAL_REGISTER:2026-${n}`,
    source: 'FEDERAL_REGISTER' as const,
    documentNumber: `2026-${n}`,
    title,
    publicationDate: `2026-10-${10 + n}`,
    agency: null,
    excerpt,
    url: null,
    kind,
    illustrative: false,
  });
  store.addFeedItems([
    item(1, 'Health data retention', RETENTION.rawLegalText),
    item(2, 'Grazing permits', 'Fees for grazing permits on federal land are adjusted for inflation.'),
    item(3, 'Correction', 'Corrects a date in 2026-1.', 'CHANGE_NOTICE'),
  ]);
  return { store, ws };
}

/** A model that answers with a summary of whatever notice it was given. */
function fakeAi(answer: (req: CompleteRequest) => Partial<CompleteResult> = () => ({ ok: true, json: { summary: 'Purge health data within 72 hours.' } })) {
  const calls: CompleteRequest[] = [];
  const ai = {
    complete: async (req: CompleteRequest) => {
      calls.push(req);
      return { ok: false, text: '', mode: 'cloud', model: 'deepseek-chat', endpointHost: 'api.deepseek.com', usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, cacheWriteTokens: 0 }, latencyMs: 1, ...answer(req) } as CompleteResult;
    },
  };
  return { ai, calls };
}

/** Events go to a webhook; a stub queue records what would be delivered. */
function withWebhook(store: ProductStore, ws: string) {
  store.setWorkspaceWebhook(ws, { url: 'https://hooks.example.test/x', events: ['regulation.watch'] });
  const queued: string[] = [];
  const queue = { enqueue: (kind: string) => (queued.push(kind), 'job') } as unknown as JobQueue;
  return { events: { store, queue, publicUrl: 'http://lexc.test' }, queued };
}

describe('regulation watch', () => {
  it('finds the rules an item may affect without a model, and summarizes it from its own text', async () => {
    const { store, ws } = setup();
    const { ai, calls } = fakeAi();
    const r = await watchRegulationFeed({ store, ai }, ws);
    expect(r).toEqual({ noted: 2, summarized: 2, errors: [] });
    // Change notices have no text to summarize.
    expect(calls.map((c) => c.prompt.match(/2026-\d/)![0])).toEqual(['2026-2', '2026-1']);
    expect(calls[0]).toMatchObject({ workspaceId: ws, task: 'regulation-watch', maxTokens: 160 });
    expect(calls[1].prompt).toContain(RETENTION.rawLegalText.slice(0, 60));
    expect(calls[1].system).toMatch(/data, not instructions/);

    const feed = new Map(store.listFeedItems(ws).map((i) => [i.documentNumber, i.watch]));
    expect(feed.get('2026-1')).toMatchObject({ category: 'RETENTION_AND_TENANT_KMS', affectedRuleKeys: ['R-1'], summary: 'Purge health data within 72 hours.', model: 'deepseek-chat' });
    expect(feed.get('2026-2')).toMatchObject({ category: null, affectedRuleKeys: [] });
    expect(feed.get('2026-3')).toBeNull();

    // Summarized items aren't sent again.
    expect(await watchRegulationFeed({ store, ai }, ws)).toEqual({ noted: 0, summarized: 0, errors: [] });
    expect(calls).toHaveLength(2);
  });

  it('keeps the rule match when AI is off, and stops asking the model', async () => {
    const { store, ws } = setup();
    const { ai, calls } = fakeAi(() => ({ refused: 'ai_off' }));
    const r = await watchRegulationFeed({ store, ai }, ws);
    expect(r).toEqual({ noted: 2, summarized: 0, refused: 'ai_off', errors: [] });
    expect(calls).toHaveLength(1);
    const note = store.listFeedItems(ws).find((i) => i.documentNumber === '2026-1')!.watch;
    expect(note).toMatchObject({ affectedRuleKeys: ['R-1'], summary: null });
  });

  it('records an invalid answer and tries again next time', async () => {
    const { store, ws } = setup();
    let bad = true;
    const { ai } = fakeAi(() => (bad ? { invalid: '"summary" must be at most 400 characters' } : { ok: true, json: { summary: 'Short.' } }));
    const first = await watchRegulationFeed({ store, ai }, ws, { limit: 1 });
    expect(first.errors).toEqual(['2026-2: "summary" must be at most 400 characters']);
    bad = false;
    expect((await watchRegulationFeed({ store, ai }, ws, { limit: 1 })).summarized).toBe(1);
  });


  it('runs after the daily feed refresh in every workspace; AI off still notes and announces, without a summary', async () => {
    const { store, ws } = setup();
    const { events, queued } = withWebhook(store, ws);
    const { ai: fake, calls } = fakeAi();
    let mode = 'off';
    const ai = { complete: async (req: CompleteRequest) => (mode === 'off' ? ({ ok: false, refused: 'ai_off' } as CompleteResult) : fake.complete(req)), settings: () => ({ mode }) } as unknown as AiGateway;
    const deps = { store, ai, events, enqueueGithubScan: () => null, fetchFeed: async () => [] };
    expect(await runDueJobs(deps, new Date('2026-12-01T02:00:00Z'))).toContain('regulation watch: 0 summaries');
    expect(calls).toHaveLength(0);
    expect(store.feedNotes(ws).size).toBe(2);
    expect(queued).toEqual(['event_delivery']);
    mode = 'cloud';
    expect(await runDueJobs(deps, new Date('2026-12-02T02:00:00Z'))).toContain('regulation watch: 2 summaries');
    // The item was announced when first noted; summarizing it later does not announce it again.
    expect(queued).toEqual(['event_delivery']);
  });

  it('announces an affecting item once, however often the watch runs', async () => {
    const { store, ws } = setup();
    const { events, queued } = withWebhook(store, ws);
    const { ai } = fakeAi(() => ({ invalid: 'bad' }));
    await watchRegulationFeed({ store, ai, events }, ws);
    await watchRegulationFeed({ store, ai, events }, ws);
    expect(queued).toEqual(['event_delivery']);
    expect(store.listOutboundDeliveries(ws)).toHaveLength(1);
  });

  it('announces an item once when two runs overlap', async () => {
    const { store, ws } = setup();
    const { events, queued } = withWebhook(store, ws);
    const { ai } = fakeAi(() => ({ ok: true, json: { summary: 'Short.' } }));
    const slow = { complete: async (req: CompleteRequest) => (await new Promise((r) => setTimeout(r, 20)), ai.complete(req)) };
    await Promise.all([watchRegulationFeed({ store, ai: slow, events }, ws), watchRegulationFeed({ store, ai: slow, events }, ws)]);
    expect(queued).toEqual(['event_delivery']);
  });
});
