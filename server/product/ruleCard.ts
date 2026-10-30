import type { AiGateway, AiMode } from '../ai/gateway.js';
import {
  checkExtraction,
  checkParserOnly,
  EXTRACTION_SCHEMA,
  extractionPrompt,
  FIELD_UNIT,
  numericFieldFor,
  validateExtraction,
  type ModelExtraction,
  type NumericField,
} from '../ai/extraction.js';
import { inferRuleCategoryFromProse } from '../compiler/legalCompiler.js';
import { verifyRepositoryAgainstClauses } from '../prover/z3Engine.js';
import type { ASTFindingNode, LegalClause, RuleCategory, SQLTableSchema } from '../../shared/types.js';
import { compileClauseSync, type ClauseValues } from './clauses.js';
import type { GovernanceStore } from './governance.js';
import type { ProductStore } from './store.js';

/** What Legal sees before approving a rule (product guide, Phase 3 and 5.4). */

export const CATEGORY_LABELS: Record<RuleCategory, string> = {
  RETENTION_AND_TENANT_KMS: 'Retention and tenant keys',
  ENCRYPTION_AT_REST: 'Encryption at rest',
  PII_LOGGING_BAN: 'No personal data in logs',
  RIGHT_TO_ERASURE_CASCADE: 'Right to erasure',
  AI_HUMAN_IN_THE_LOOP: 'Human review of AI decisions',
  CROSS_BORDER_TRANSFER: 'Data residency',
  CONSENT_LAWFUL_BASIS: 'Consent and lawful basis',
  BREACH_NOTIFICATION: 'Breach notification',
  DPIA_REQUIRED: 'Impact assessment',
  DATA_MINIMISATION: 'Data minimisation',
  PURPOSE_LIMITATION: 'Purpose limitation',
};

export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  const hours = `${Number.isInteger(h) ? h : Math.round(h * 100) / 100} hour${h === 1 ? '' : 's'}`;
  return h >= 48 && h % 24 === 0 ? `${hours} (${h / 24} days)` : hours;
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** A fixed plain-language reading per category, from the compiled values. */
export function plainReading(clause: LegalClause): string {
  const p = clause.deontic.extractedParameters;
  switch (clause.category) {
    case 'RETENTION_AND_TENANT_KMS':
      return `Personal data must be deleted within ${formatHours(p.maxRetentionHours ?? 720)}${p.requiresTenantIsolatedKeys ? ", and each tenant's data must be encrypted with that tenant's own key" : ''}.`;
    case 'ENCRYPTION_AT_REST':
      return 'Personal data must be encrypted wherever it is stored.';
    case 'PII_LOGGING_BAN':
      return 'Personal data must not be written to logs unless it is redacted first.';
    case 'RIGHT_TO_ERASURE_CASCADE':
      return "When a person asks to be erased, their data must be deleted everywhere it is linked.";
    case 'AI_HUMAN_IN_THE_LOOP':
      return `A person must review automated decisions when the model's confidence is below ${pct(p.minAiConfidenceThreshold ?? 0.7)}, and each decision must be logged.`;
    case 'CROSS_BORDER_TRANSFER':
      return `Personal data may only be stored and processed in ${(p.allowedDataRegions ?? []).join(', ') || 'approved regions'}.`;
    case 'CONSENT_LAWFUL_BASIS':
      return 'Personal data may only be processed after consent or another lawful basis is recorded.';
    case 'BREACH_NOTIFICATION':
      return `A personal data breach must be reported within ${formatHours(p.maxBreachNotificationHours ?? 72)}.`;
    case 'DPIA_REQUIRED':
      return 'High-risk processing needs a data protection impact assessment first.';
    case 'DATA_MINIMISATION':
      return 'Only personal data fields that are actually used may be collected.';
    case 'PURPOSE_LIMITATION':
      return p.allowedProcessingPurposes?.length ? `Personal data may only be used for: ${p.allowedProcessingPurposes.join(', ')}.` : 'Each use of personal data must declare its purpose.';
  }
}

export interface Highlight {
  start: number;
  end: number;
  kind: 'value' | 'obligation' | 'quote';
}

const OBLIGATION_RE = /\b(?:must not|must|shall not|shall|may not|may only|prohibited|is required|are required|required to|never)\b|অবশ্যই|করতে হবে|নিষিদ্ধ|যাবে না|বাধ্যতামূলক|লাগবে/giu;
const VALUE_RE =
  /\b(?:\d+(?:\.\d+)?|half an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty-eight|seventy-two|ninety)(?:\s*\(\d+\))?\s*(?:hours?|hrs?|minutes?|days?|weeks?|fortnights?|months?|years?)\b|\ba fortnight\b|\b\d{1,3}(?:\.\d+)?\s*(?:%|percent)|\b0\.\d+\b|[০-৯]+(?:\.[০-৯]+)?\s*(?:ঘণ্টা|ঘন্টা|দিন|শতাংশ)|[০-৯]\.[০-৯]+/giu;

/** Words to highlight on the card: the model's verified quote, values, and obligation words. */
export function highlights(text: string, quote: string | null): Highlight[] {
  const out: Highlight[] = [];
  if (quote) {
    const i = text.toLowerCase().indexOf(quote.toLowerCase());
    if (i >= 0) out.push({ start: i, end: i + quote.length, kind: 'quote' });
  }
  for (const m of text.matchAll(VALUE_RE)) out.push({ start: m.index!, end: m.index! + m[0].length, kind: 'value' });
  for (const m of text.matchAll(OBLIGATION_RE)) out.push({ start: m.index!, end: m.index! + m[0].length, kind: 'obligation' });
  // Keep the first of overlapping ranges (quote, then values, then words), then sort.
  const kept: Highlight[] = [];
  for (const h of out) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}

export interface RuleCardValue {
  field: NumericField | null;
  unit: string | null;
  value: number | null;
  status: 'confirmed' | 'question' | 'set_by_legal' | 'not_needed';
  question: string | null;
  parserValue: number | null;
  modelValue: number | null;
  quote: string | null;
}

export interface RuleCard {
  category: RuleCategory;
  categoryLabel: string;
  inferredCategory: RuleCategory;
  value: RuleCardValue;
  ai: { mode: AiMode; status: 'off' | 'not_needed' | 'ok' | 'refused' | 'invalid' | 'error'; model: string | null; endpointHost: string | null; detail: string | null; tokens: number; latencyMs: number };
  highlights: Highlight[];
  plainReading: string;
  reviewNotes: string[];
  impact: Array<{ repoId: string; repoFullName: string; commitSha: string; scannedAt: string | null; failing: number; locations: Array<{ filePath: string; line: number; explanation: string }> }>;
  compiled: { smtLib2: string; rego: string; formula: string };
}

export async function analyzeRule(
  input: { workspaceId: string; text: string; category?: RuleCategory; values?: ClauseValues; key?: string },
  deps: { store: ProductStore; gov: GovernanceStore; ai: AiGateway }
): Promise<RuleCard> {
  const text = input.text.trim();
  const inferred = inferRuleCategoryFromProse(text);
  const category = input.category ?? inferred;
  const field = numericFieldFor(category);
  const mode = deps.ai.modeFor(input.workspaceId);
  const ai: RuleCard['ai'] = { mode, status: mode === 'off' ? 'off' : 'not_needed', model: null, endpointHost: null, detail: null, tokens: 0, latencyMs: 0 };

  let value: RuleCardValue = { field, unit: field ? FIELD_UNIT[field] : null, value: null, status: 'not_needed', question: null, parserValue: null, modelValue: null, quote: null };
  if (field) {
    let checked = checkParserOnly(text, category);
    if (mode !== 'off') {
      const { system, prompt } = extractionPrompt(text, field);
      const r = await deps.ai.complete({ workspaceId: input.workspaceId, task: 'drafting', system, prompt, schema: EXTRACTION_SCHEMA, validate: validateExtraction, maxTokens: 200, timeoutMs: 25_000 });
      Object.assign(ai, { model: r.model || null, endpointHost: r.endpointHost || null, tokens: r.usage.promptTokens + r.usage.completionTokens, latencyMs: r.latencyMs });
      if (r.refused) Object.assign(ai, { status: 'refused', detail: r.refused === 'budget' ? "Today's AI token budget is used up." : r.refused === 'no_model' ? 'No model is configured for this mode.' : 'AI is off.' });
      else if (r.error) Object.assign(ai, { status: 'error', detail: r.error.slice(0, 200) });
      else if (!r.ok) Object.assign(ai, { status: 'invalid', detail: r.invalid ?? 'The answer was not valid JSON.' });
      else {
        ai.status = 'ok';
        checked = checkExtraction(text, category, r.json as ModelExtraction) ?? checked;
      }
    }
    if (checked) {
      value = { ...value, value: checked.value, status: checked.status === 'accepted' ? 'confirmed' : 'question', question: checked.question, parserValue: checked.parserValue, modelValue: checked.modelValue, quote: checked.quote };
    }
    const legal = input.values?.[field];
    if (legal !== undefined) value = { ...value, value: legal, status: 'set_by_legal', question: null };
  }

  const values: ClauseValues = field && value.value !== null ? { [field]: value.value } : {};
  const clause = compileClauseSync({ text, key: input.key ?? 'DRAFT', category, values });

  // Impact preview: the draft against each repository's latest default-branch scan.
  const impact: RuleCard['impact'] = [];
  for (const repo of deps.store.listRepos(input.workspaceId)) {
    const scan = deps.gov.latestBranchScan(repo.id, true);
    if (!scan?.facts) continue;
    const { proofs } = await verifyRepositoryAgainstClauses([clause], scan.facts.sqlTables as SQLTableSchema[], scan.facts.astFindings as ASTFindingNode[]);
    const locations = proofs.flatMap((p) => (p.status === 'UNSAT_VIOLATION' ? p.offendingLocations : [])).map((l) => ({ filePath: l.filePath, line: l.line, explanation: l.explanation }));
    impact.push({ repoId: repo.id, repoFullName: repo.fullName, commitSha: scan.commitSha, scannedAt: scan.finishedAt, failing: locations.length, locations: locations.slice(0, 20) });
  }

  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    inferredCategory: inferred,
    value,
    ai,
    highlights: highlights(text, value.status === 'confirmed' ? value.quote : null),
    plainReading: plainReading(clause),
    reviewNotes: clause.deontic.extractionProvenance?.reviewNotes ?? [],
    impact,
    compiled: { smtLib2: clause.compiled.smtLib2Snippet, rego: clause.compiled.opaRegoRule, formula: clause.compiled.deonticFormula },
  };
}
