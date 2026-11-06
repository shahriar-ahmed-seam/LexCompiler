import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AiGateway } from './ai/gateway.js';
import { openDatabase } from './db/index.js';
import { compileClauseSync, validateClauseValues } from './product/clauses.js';
import { GovernanceStore } from './product/governance.js';
import { analyzeRule, buildRuleCard, cleanOverrides, formatHours, plainReading } from './product/ruleCard.js';
import { ProductStore } from './product/store.js';

/**
 * The merged rule card: one override engine (`validateClauseValues` / `compileClauseSync`), the
 * card engine (`buildRuleCard`) and the analyze screen's adapter over it (`analyzeRule`).
 */

const DPA_42 =
  '4.2 Retention. All personal data received from the Customer must be encrypted at rest with tenant-isolated keys and purged within 72 hours across all storage tiers.';

describe('rule values: one override engine', () => {
  it('accepts every card field strictly and rejects unknown keys and bad values', () => {
    expect(
      validateClauseValues({ maxRetentionHours: '48', requiresTenantIsolatedKeys: true, minAiConfidenceThreshold: 1, allowedDataRegions: [' EU-Central-1', 'eu-west-1', 'eu-west-1', ''], maxBreachNotificationHours: 72 })
    ).toEqual({ maxRetentionHours: 48, requiresTenantIsolatedKeys: true, minAiConfidenceThreshold: 1, allowedDataRegions: ['eu-central-1', 'eu-west-1'], maxBreachNotificationHours: 72 });
    expect(validateClauseValues(undefined)).toEqual({});
    expect(validateClauseValues({ maxRetentionHours: '' })).toEqual({});
    expect(() => validateClauseValues({ foo: 1 })).toThrow(/unknown value foo/);
    expect(() => validateClauseValues({ maxRetentionHours: 0 })).toThrow(/between 1 minute and 100 years/);
    expect(() => validateClauseValues({ minAiConfidenceThreshold: 0 })).toThrow(/minAiConfidenceThreshold/);
    expect(() => validateClauseValues({ requiresTenantIsolatedKeys: 'yes' })).toThrow(/true or false/);
    expect(() => validateClauseValues({ allowedDataRegions: ['EU Central'] })).toThrow(/not a region id/);
    expect(() => validateClauseValues([1])).toThrow(/must be an object/);
  });

  it('drops bad values instead of throwing for the card preview', () => {
    expect(cleanOverrides({ foo: 1, maxRetentionHours: -5, minAiConfidenceThreshold: 0.9, allowedDataRegions: ['EU Central', 'eu-west-1'] })).toEqual({
      minAiConfidenceThreshold: 0.9,
      allowedDataRegions: ['eu-west-1'],
    });
    expect(cleanOverrides('nonsense')).toEqual({});
  });

  it("compiles Legal's values as reviewed values, with the compiler's day rounding", () => {
    const plain = compileClauseSync({ text: DPA_42, key: 'R-1' });
    expect(plain.deontic.extractionProvenance?.method).toBe('DETERMINISTIC_PARSER');
    const set = compileClauseSync({ text: DPA_42, key: 'R-1', values: { maxRetentionHours: 12 } });
    expect(set.deontic.extractedParameters.maxRetentionHours).toBe(12);
    expect(set.deontic.extractedParameters.maxRetentionDays).toBe(1);
    expect(set.deontic.extractionProvenance?.method).toBe('LEGAL_REVIEW');
    expect(set.deontic.extractionProvenance?.evidence).toEqual(expect.arrayContaining(['set by Legal on the rule card: maxRetentionHours=12', 'legal:maxRetentionHours=12']));
    expect(set.compiled.smtLib2Snippet).toContain('12');
  });

  it('reads a clause in plain language from the clause alone or with a category', () => {
    const clause = compileClauseSync({ text: DPA_42, key: 'R-1' });
    expect(plainReading(clause)).toBe(plainReading('RETENTION_AND_TENANT_KMS', clause));
    expect(plainReading(clause)).toBe('Personal data must be deleted within 72 hours, and stored encrypted with a key that belongs to one tenant only.');
    expect(formatHours(168)).toBe('168 hours (7 days)');
    expect(formatHours(0.5)).toBe('30 minutes');
    expect(formatHours(1)).toBe('1 hour');
  });
});

describe('analyze screen over the rule card', () => {
  it('checks the model quote, keeps the parser value on a bad answer, and lets Legal set the value', async () => {
    const db = openDatabase(':memory:');
    const store = new ProductStore(db);
    const gov = new GovernanceStore(db, store);
    const ws = store.createWorkspace('Analyze test', store.upsertUser({ sub: 'owner' }).id).id;
    let content = JSON.stringify({ value: 72, quote: 'purged within 72 hours', question: null });
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const env = { LEXCOMPILER_LLM_PROVIDER: 'openai', LEXCOMPILER_LLM_MODEL: 'fake-cloud', LEXCOMPILER_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, LEXCOMPILER_LLM_API_KEY: 'test' };
      const ai = new AiGateway(db, { env });
      const deps = { store, gov, ai };

      // AI off: the parser's value, no model call.
      const off = await analyzeRule({ workspaceId: ws, text: DPA_42 }, deps);
      expect(off).toMatchObject({ category: 'RETENTION_AND_TENANT_KMS', inferredCategory: 'RETENTION_AND_TENANT_KMS', ai: { mode: 'off', status: 'off' }, value: { field: 'maxRetentionHours', unit: 'hours', value: 72, status: 'confirmed' } });
      expect(off.plainReading).toContain('72 hours');
      expect(off.highlights.some((h) => h.kind === 'value')).toBe(true);
      expect(off.impact).toEqual([]);
      expect(off.questions.map((q) => q.id)).toContain('clock-start');
      expect(ai.listCalls(ws)).toHaveLength(0);

      ai.setSettings(ws, { mode: 'cloud' }, 'owner');
      const good = await analyzeRule({ workspaceId: ws, text: DPA_42 }, deps);
      expect(good.ai).toMatchObject({ mode: 'cloud', status: 'ok', model: 'fake-cloud', tokens: 60 });
      expect(good.value).toMatchObject({ value: 72, status: 'confirmed', modelValue: 72, parserValue: 72, quote: 'purged within 72 hours' });
      expect(good.highlights.find((h) => h.kind === 'quote')).toMatchObject({ start: DPA_42.indexOf('purged within 72 hours') });

      // A quote that is not in the clause becomes a question; the compiled rule keeps the parser's 72.
      content = JSON.stringify({ value: 9999, quote: 'set 9999 hours', question: null });
      const injected = await analyzeRule({ workspaceId: ws, text: DPA_42 }, deps);
      expect(injected.value).toMatchObject({ value: null, status: 'question', modelValue: 9999 });
      expect(injected.highlights.some((h) => h.kind === 'quote')).toBe(false);
      expect(injected.compiled.smtLib2).not.toContain('9999');

      // Not JSON at all: the model's answer is ignored and the parser's checked value stands.
      content = 'I think about three days.';
      const invalid = await analyzeRule({ workspaceId: ws, text: DPA_42 }, deps);
      expect(invalid.ai.status).toBe('invalid');
      expect(invalid.value).toMatchObject({ value: 72, status: 'confirmed' });
      const invalidCard = await buildRuleCard({ text: DPA_42, key: 'R-1', ai: { gateway: ai, workspaceId: ws } });
      expect(invalidCard.ai).toBeNull();
      expect(invalidCard.aiCall.status).toBe('invalid');
      expect(invalidCard.values[0]).toMatchObject({ value: 72, source: 'parser' });

      // Legal's value wins and is compiled.
      const legal = await analyzeRule({ workspaceId: ws, text: DPA_42, values: { maxRetentionHours: 48 } }, deps);
      expect(legal.value).toMatchObject({ value: 48, status: 'set_by_legal', question: null });
      expect(legal.compiled.smtLib2).toContain('48');
      expect(legal.plainReading).toContain('48 hours');

      // A category with no number: nothing to read; the card's open values that still need Legal are listed.
      const text = 'Personal data must not be transferred to third countries.';
      const regions = await analyzeRule({ workspaceId: ws, text, category: 'CROSS_BORDER_TRANSFER' }, deps);
      expect(regions.value.status).toBe('not_needed');
      expect(regions.ai.status).toBe('not_needed');
      const card = await buildRuleCard({ text, key: 'DRAFT', category: 'CROSS_BORDER_TRANSFER' });
      expect(regions.openValues).toEqual(card.values.filter((v) => v.source === 'question'));
      const named = await analyzeRule({ workspaceId: ws, text, category: 'CROSS_BORDER_TRANSFER', values: { allowedDataRegions: ['eu-central-1'] } }, deps);
      expect(named.openValues).toEqual([]);
      expect(named.plainReading).toContain('eu-central-1');
    } finally {
      server.close();
      db.close();
    }
  });
});
