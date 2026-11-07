import { describe, expect, it } from 'vitest';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import type { EvidenceRecorder } from './evidence/records.js';
import type { JobQueue } from './jobs/queue.js';
import { compileClauseSync } from './product/clauses.js';
import { decideException, requestExceptions, type FlowDeps } from './product/flows.js';
import { ProductStore } from './product/store.js';

/** Emit points of the exception flows: one event per real change, and a failing evidence signer cannot lose it. */
function setup() {
  const store = new ProductStore(openDatabase(':memory:'));
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  const ws = store.createWorkspace('FinHealth AI', arif.id).id;
  const c = getInitialClauses().find((x) => x.category === 'PII_LOGGING_BAN')!;
  const clause = compileClauseSync({ text: c.rawLegalText, key: store.nextRuleKey(ws), title: c.title, citation: c.citation, category: c.category });
  const { version } = store.createRuleDraft({ workspaceId: ws, title: c.title, sourceText: c.rawLegalText, clause, createdBy: arif.id });
  store.approveRuleVersion(ws, version.id, arif.id);
  const rule = store.rulesInEffect(ws)[0];
  store.setWorkspaceWebhook(ws, { url: 'https://hooks.example.test/x', events: ['exception.requested', 'exception.decided'] });
  const queued: Array<{ kind: string; payload: { event: { type: string } } }> = [];
  const queue = { enqueue: (kind: string, payload: never) => (queued.push({ kind, payload }), 'job') } as unknown as JobQueue;
  const failing = {
    exceptionRequested: async () => {
      throw new Error('signer unavailable');
    },
    exceptionChanged: async () => {
      throw new Error('signer unavailable');
    },
  } as unknown as EvidenceRecorder;
  const deps: FlowDeps = { store, queue, publicUrl: 'http://lexc.test' };
  const finding = { ruleId: rule.ruleId, ruleKey: rule.ruleKey, repoId: null, pathGlob: 'src/**' };
  const request = { workspaceId: ws, findings: [finding], reason: 'Legacy module', requestedBy: arif.id, requesterLabel: 'Arif', via: 'dashboard' as const };
  const types = () => queued.filter((q) => q.kind === 'event_delivery').map((q) => q.payload.event.type);
  return { store, ws, arif, deps, failing, request, types };
}

describe('exception events', () => {
  it('queues one exception.requested per new request and none for a repeat', async () => {
    const { deps, request, types } = setup();
    await requestExceptions(deps, request);
    expect(types()).toEqual(['exception.requested']);
    await requestExceptions(deps, request);
    expect(types()).toEqual(['exception.requested']);
  });

  it('queues exception.decided once, and rejects a second decision without another event', async () => {
    const { store, ws, arif, deps, request, types } = setup();
    const [req] = await requestExceptions(deps, request);
    const decide = () => decideException(deps, { workspaceId: ws, exceptionId: req.id, decision: 'rejected', userId: arif.id, note: 'no' });
    await decide();
    await expect(decide()).rejects.toThrow();
    expect(types()).toEqual(['exception.requested', 'exception.decided']);
    expect(store.listOutboundDeliveries(ws)).toHaveLength(2);
  });

  it('still queues the events when the evidence recorder throws', async () => {
    const { ws, arif, deps, failing, request, types } = setup();
    const withFailingEvidence: FlowDeps = { ...deps, evidence: failing };
    await expect(requestExceptions(withFailingEvidence, request)).rejects.toThrow('signer unavailable');
    expect(types()).toEqual(['exception.requested']);
    const [existing] = deps.store.listExceptions(ws, { status: 'requested' });
    await expect(decideException(withFailingEvidence, { workspaceId: ws, exceptionId: existing.id, decision: 'rejected', userId: arif.id, note: 'no' })).rejects.toThrow('signer unavailable');
    expect(types()).toEqual(['exception.requested', 'exception.decided']);
  });

  it('queues nothing for a workspace without a webhook', async () => {
    const { store, ws, deps, request, types } = setup();
    store.deleteWorkspaceWebhook(ws);
    await requestExceptions(deps, request);
    expect(types()).toEqual([]);
  });
});
