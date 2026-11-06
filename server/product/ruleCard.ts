import crypto from 'node:crypto';
import {
  findConfidenceThresholds,
  findTemporalDurations,
  inferRuleCategoryFromProse,
  inferRuleCategoryWithEvidence,
  type RuleValueOverrides,
} from '../compiler/legalCompiler.js';
import {
  checkExtraction,
  checkParserOnly,
  EXTRACTION_SCHEMA,
  extractionPrompt,
  FIELD_UNIT,
  numericFieldFor,
  validateExtraction,
  type CheckedValue,
  type ModelExtraction,
  type NumericField,
} from '../ai/extraction.js';
import type { AiGateway, AiMode } from '../ai/gateway.js';
import { verifyRepositoryAgainstClauses } from '../prover/z3Engine.js';
import type { ASTFindingNode, LegalClause, RuleCategory, SQLTableSchema } from '../../shared/types.js';
import { compileClauseSync, isRuleCategory, validateClauseValues, type ClauseValues } from './clauses.js';
import { asciiDigits } from './documents.js';
import type { GovernanceStore } from './governance.js';
import type { ProductStore } from './store.js';

/**
 * The rule card (product guide, Phase 3 and 5.4): what Legal sees before approving a clause as a
 * rule. Values come from the deterministic parser. With AI on, a model may suggest a value, but it
 * is shown only when the quote is in the clause and the parser reads the same value from the
 * quote and from the whole clause (`checkExtraction`); otherwise the card asks a question.
 *
 * `buildRuleCard` is the one engine. `analyzeRule` (the web app's "analyze" screen) is an adapter
 * over it that returns the single-value `AnalyzedRule` shape.
 */

export const CATEGORY_LABELS: Record<RuleCategory, string> = {
  RETENTION_AND_TENANT_KMS: 'Retention and tenant keys',
  ENCRYPTION_AT_REST: 'Encryption at rest',
  PII_LOGGING_BAN: 'No personal data in logs',
  RIGHT_TO_ERASURE_CASCADE: 'Right to erasure',
  AI_HUMAN_IN_THE_LOOP: 'Human review of AI decisions',
  CROSS_BORDER_TRANSFER: 'Data transfers and regions',
  CONSENT_LAWFUL_BASIS: 'Consent and lawful basis',
  BREACH_NOTIFICATION: 'Breach notification',
  DPIA_REQUIRED: 'Impact assessment (DPIA)',
  DATA_MINIMISATION: 'Data minimisation',
  PURPOSE_LIMITATION: 'Purpose limitation',
};

/** "72 hours", "168 hours (7 days)", "30 minutes". */
export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  const hours = `${Number.isInteger(h) ? h : Math.round(h * 100) / 100} hour${h === 1 ? '' : 's'}`;
  return h >= 48 && h % 24 === 0 ? `${hours} (${h / 24} days)` : hours;
}

/** The fixed questions per category (guide, Phase 3 item 3). */
const CATEGORY_QUESTIONS: Partial<Record<RuleCategory, Array<{ id: string; text: string; sets?: keyof RuleValueOverrides }>>> = {
  RETENTION_AND_TENANT_KMS: [
    { id: 'clock-start', text: 'When does the retention clock start: at upload, or when processing ends?' },
    { id: 'backups', text: 'Do backups count toward the retention period?' },
  ],
  PII_LOGGING_BAN: [{ id: 'masked-values', text: 'Are masked values (for example the last 4 digits) allowed in logs?' }],
  AI_HUMAN_IN_THE_LOOP: [{ id: 'automated-decisions', text: 'Which decisions count as automated?' }],
  CROSS_BORDER_TRANSFER: [
    { id: 'allowed-regions', text: 'Which regions are allowed? (comma-separated, for example eu-central-1, eu-west-1)', sets: 'allowedDataRegions' },
    { id: 'sub-processors', text: 'Do sub-processors count as transfers?' },
  ],
  BREACH_NOTIFICATION: [{ id: 'notify-whom', text: 'Who must be notified: the supervisory authority, the customer, or both?' }],
};

export interface Highlight {
  start: number;
  end: number;
  text: string;
  kind: 'value' | 'keyword' | 'normative';
}

export interface CardValue {
  field: keyof RuleValueOverrides;
  label: string;
  value: number | boolean | string[] | null;
  /** parser: read by our parser; model: suggested by a model and confirmed by the parser; legal: set by hand; question: needs Legal. */
  source: 'parser' | 'model' | 'legal' | 'question';
  question: string | null;
}

export interface CardQuestion {
  id: string;
  text: string;
  /** The value an answer sets, when it changes the check (allowed regions). */
  sets?: keyof RuleValueOverrides;
}

export interface AiSuggestion {
  model: string;
  promptSha256: string;
  checked: CheckedValue;
}

export type AiCallStatus = 'off' | 'not_needed' | 'ok' | 'refused' | 'invalid' | 'error';

/** What happened to the model call behind a card: shown as the model badge in the web app. */
export interface AiCallSummary {
  mode: AiMode;
  /** off: AI is off; not_needed: the category has no number to read; ok: the model answered; refused / invalid / error: no usable answer, the parser's value stands. */
  status: AiCallStatus;
  model: string | null;
  endpointHost: string | null;
  detail: string | null;
  tokens: number;
  latencyMs: number;
}

export interface RuleCard {
  category: RuleCategory;
  categoryLabel: string;
  /** True when the wording points to the category; false when it is a fallback Legal should check. */
  categoryFromWording: boolean;
  plainReading: string;
  highlights: Highlight[];
  values: CardValue[];
  questions: CardQuestion[];
  ai: AiSuggestion | null;
  /** Set when AI is on but no suggestion was made (the call failed or was refused). */
  aiNote: string | null;
  /** The model call itself: mode, outcome, model, host, tokens and latency. */
  aiCall: AiCallSummary;
  clause: LegalClause;
}

const VALUE_LABELS: Record<keyof RuleValueOverrides, string> = {
  maxRetentionHours: 'Delete within (hours)',
  requiresTenantIsolatedKeys: 'Tenant-isolated keys',
  minAiConfidenceThreshold: 'Human review below confidence',
  allowedDataRegions: 'Allowed regions',
  maxBreachNotificationHours: 'Report a breach within (hours)',
};

/** The values a category's check uses. */
function fieldsFor(category: RuleCategory): Array<keyof RuleValueOverrides> {
  switch (category) {
    case 'RETENTION_AND_TENANT_KMS':
      return ['maxRetentionHours', 'requiresTenantIsolatedKeys'];
    case 'AI_HUMAN_IN_THE_LOOP':
      return ['minAiConfidenceThreshold'];
    case 'CROSS_BORDER_TRANSFER':
      return ['allowedDataRegions'];
    case 'BREACH_NOTIFICATION':
      return ['maxBreachNotificationHours'];
    default:
      return [];
  }
}

function parameterValue(clause: LegalClause, field: keyof RuleValueOverrides): CardValue['value'] {
  const p = clause.deontic.extractedParameters;
  const v = p[field];
  return v === undefined ? null : (v as CardValue['value']);
}

/** Hours as the reading states them: "72 hours" (no days in brackets), minutes under an hour. */
const hoursText = (h: number | undefined) => (h === undefined ? '? hours' : h < 1 ? formatHours(h) : formatHours(h).replace(/ \(\d+(?:\.\d+)? days\)$/, ''));

/**
 * Plain-language reading from a fixed template per category. Call it with the clause alone (its
 * own category) or with the category the card shows.
 */
export function plainReading(clause: LegalClause): string;
export function plainReading(category: RuleCategory, clause: LegalClause): string;
export function plainReading(a: RuleCategory | LegalClause, b?: LegalClause): string {
  const clause = typeof a === 'string' ? b : a;
  if (!clause) throw new TypeError('plainReading needs a clause');
  const category = typeof a === 'string' ? a : a.category;
  const p = clause.deontic.extractedParameters;
  switch (category) {
    case 'RETENTION_AND_TENANT_KMS':
      return `Personal data must be deleted within ${hoursText(p.maxRetentionHours)}${p.requiresTenantIsolatedKeys ? ', and stored encrypted with a key that belongs to one tenant only' : ''}.`;
    case 'ENCRYPTION_AT_REST':
      return `Columns with personal data must be encrypted at rest${p.requiredEncryptionAlgorithms?.length ? ` (${p.requiredEncryptionAlgorithms.join(', ')})` : ''}.`;
    case 'PII_LOGGING_BAN':
      return 'Personal data must not be written to logs unless it is redacted first.';
    case 'RIGHT_TO_ERASURE_CASCADE':
      return 'Deleting a person must also delete the rows that refer to them.';
    case 'AI_HUMAN_IN_THE_LOOP':
      return `A person must review automated decisions whose model confidence is below ${p.minAiConfidenceThreshold ?? '?'}.`;
    case 'CROSS_BORDER_TRANSFER':
      return p.allowedDataRegions?.length ? `Personal data may only be stored or sent in ${p.allowedDataRegions.join(', ')}.` : 'Personal data must not leave the allowed regions. Which regions are allowed?';
    case 'CONSENT_LAWFUL_BASIS':
      return 'Personal data may only be processed after a consent or lawful-basis check.';
    case 'BREACH_NOTIFICATION':
      return `A personal data breach must be reported within ${hoursText(p.maxBreachNotificationHours)}.`;
    case 'DPIA_REQUIRED':
      return 'High-risk processing needs a data protection impact assessment on file.';
    case 'DATA_MINIMISATION':
      return 'Collect only the personal data the service uses.';
    case 'PURPOSE_LIMITATION':
      return `Personal data may only be used for ${p.allowedProcessingPurposes?.length ? p.allowedProcessingPurposes.join(', ') : 'the stated purposes'}.`;
  }
}

const KEYWORDS: Partial<Record<RuleCategory, RegExp>> = {
  RETENTION_AND_TENANT_KMS: /tenant[- ]isolated(?:\s+(?:kms\s+)?keys?)?|tenant[- ]specific\s+keys?|per[- ]tenant\s+keys?|customer[- ]managed\s+keys?|purged?|deleted|erased|টেন্যান্ট\s*আইসোলেটেড(?:\s*কেএমএস\s*কী)?|মুছে\s*ফেলতে/giu,
  ENCRYPTION_AT_REST: /encrypt(?:ed|ion)?\s+at\s+rest|aes-?256|এনক্রিপ্ট\S*/giu,
  PII_LOGGING_BAN: /unredacted|plain\s?text|logs?|logging|redact\S*|লগ\S*/giu,
  RIGHT_TO_ERASURE_CASCADE: /erasure|cascade|forgotten/giu,
  AI_HUMAN_IN_THE_LOOP: /human\s+(?:review|oversight)|automated\s+decisions?|confidence|মানব\s*তদারকি/giu,
  CROSS_BORDER_TRANSFER: /\b(?:eu|european union|eea|third countr(?:y|ies)|us-east-\d|eu-[a-z]+-\d)\b/giu,
  BREACH_NOTIFICATION: /breach|notify|notification/giu,
};

/**
 * Matched words with offsets in the clause text. Values are found in a copy with ASCII digits,
 * which has the same length as the original, so offsets carry over to Bangla text.
 */
export function findHighlights(text: string, category: RuleCategory, normative: Array<{ start: number; end: number; text: string }> = []): Highlight[] {
  const ascii = asciiDigits(text);
  const lower = ascii.toLowerCase();
  const out: Highlight[] = [];
  const addAll = (needle: string, kind: Highlight['kind']) => {
    if (!needle) return;
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) out.push({ start: i, end: i + needle.length, text: text.slice(i, i + needle.length), kind });
  };
  if (lower.length === text.length) {
    const field = numericFieldFor(category);
    if (field === 'minAiConfidenceThreshold') for (const t of findConfidenceThresholds(lower)) addAll(t.text, 'value');
    else if (field) for (const d of findTemporalDurations(lower)) addAll(d.text, 'value');
    if (category === 'AI_HUMAN_IN_THE_LOOP') for (const m of lower.matchAll(/\d+(?:\.\d+)?\s*%/g)) out.push({ start: m.index!, end: m.index! + m[0].length, text: text.slice(m.index!, m.index! + m[0].length), kind: 'value' });
  }
  const kw = KEYWORDS[category];
  if (kw) for (const m of text.matchAll(kw)) out.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], kind: 'keyword' });
  for (const n of normative) out.push({ ...n, kind: 'normative' });
  // Keep the longest of overlapping highlights; values win over keywords.
  const rank = { value: 0, keyword: 1, normative: 2 } as const;
  out.sort((a, b) => a.start - b.start || rank[a.kind] - rank[b.kind] || b.end - a.end);
  const kept: Highlight[] = [];
  for (const h of out) {
    const last = kept[kept.length - 1];
    if (last && h.start < last.end) continue;
    kept.push(h);
  }
  return kept;
}

export interface CardInput {
  text: string;
  key: string;
  title?: string;
  citation?: string;
  /** Legal's choice; the wording decides otherwise. */
  category?: RuleCategory;
  overrides?: RuleValueOverrides;
  normativeMatches?: Array<{ start: number; end: number; text: string }>;
  /** With a gateway and a workspace whose AI is on, the model suggests the numeric value. */
  ai?: { gateway: AiGateway; workspaceId: string };
}

/** Builds the card. Without overrides, the clause is exactly what `compileClauseSync` gives. */
export async function buildRuleCard(input: CardInput): Promise<RuleCard> {
  const fromWording = inferRuleCategoryWithEvidence(input.text);
  const category = input.category && isRuleCategory(input.category) ? input.category : (fromWording ?? 'RETENTION_AND_TENANT_KMS');
  const overrides = cleanOverrides(input.overrides ?? {});

  // Parser first; a model suggestion is checked against it.
  const parser = checkParserOnly(input.text, category);
  let ai: AiSuggestion | null = null;
  let aiNote: string | null = null;
  const field = numericFieldFor(category);
  const mode: AiMode = input.ai ? input.ai.gateway.modeFor(input.ai.workspaceId) : 'off';
  const aiCall: AiCallSummary = { mode, status: mode === 'off' ? 'off' : 'not_needed', model: null, endpointHost: null, detail: null, tokens: 0, latencyMs: 0 };
  if (input.ai && field && mode !== 'off') {
    const { system, prompt } = extractionPrompt(input.text, field);
    const r = await input.ai.gateway.complete({
      workspaceId: input.ai.workspaceId,
      task: 'drafting',
      system,
      prompt,
      schema: EXTRACTION_SCHEMA,
      validate: validateExtraction,
      maxTokens: 200,
      // A local model can be slow on a laptop; a cloud model answers fast or not at all.
      timeoutMs: mode === 'local' ? 120_000 : 25_000,
    });
    Object.assign(aiCall, { model: r.model || null, endpointHost: r.endpointHost || null, tokens: r.usage.promptTokens + r.usage.completionTokens, latencyMs: r.latencyMs });
    if (r.refused) {
      aiNote = r.refused === 'budget' ? 'The daily AI budget is used up; values come from the parser only.' : 'No model is configured for this AI mode; values come from the parser only.';
      Object.assign(aiCall, { status: 'refused', detail: r.refused === 'budget' ? "Today's AI token budget is used up." : r.refused === 'no_model' ? 'No model is configured for this mode.' : 'AI is off.' });
    } else if (r.error) {
      aiNote = `The model call failed (${r.error}); values come from the parser only.`;
      Object.assign(aiCall, { status: 'error', detail: r.error.slice(0, 200) });
    } else if (!r.ok) {
      // The model answered, but not with valid JSON: its answer is ignored and the parser's checked value stands.
      const detail = r.invalid ?? 'The answer was not valid JSON.';
      aiNote = `The model's answer was not usable (${detail}); values come from the parser only.`;
      Object.assign(aiCall, { status: 'invalid', detail: detail.slice(0, 200) });
    } else {
      aiCall.status = 'ok';
      const promptSha256 = crypto.createHash('sha256').update(`${system}\n\n${prompt}`, 'utf8').digest('hex');
      ai = { model: r.model, promptSha256, checked: checkExtraction(input.text, category, r.json as ModelExtraction)! };
    }
  }

  const compiled = compileClauseSync({ text: input.text, key: input.key, title: input.title, citation: input.citation, category, values: overrides });

  const values: CardValue[] = fieldsFor(category).map((f) => {
    const label = VALUE_LABELS[f];
    if (overrides[f] !== undefined) return { field: f, label, value: overrides[f] as CardValue['value'], source: 'legal', question: null };
    if (f === field) {
      const checked = ai?.checked ?? parser;
      if (checked && checked.status === 'question') return { field: f, label, value: null, source: 'question', question: checked.question };
      return { field: f, label, value: checked?.value ?? parameterValue(compiled, f), source: ai?.checked.status === 'accepted' ? 'model' : 'parser', question: null };
    }
    const v = parameterValue(compiled, f);
    if (f === 'allowedDataRegions' && (!Array.isArray(v) || v.length === 0)) return { field: f, label, value: [], source: 'question', question: 'The clause names no allowed region. Which regions are allowed?' };
    return { field: f, label, value: v, source: 'parser', question: null };
  });

  const questions: CardQuestion[] = [
    ...(compiled.deontic.extractionProvenance?.reviewNotes ?? []).map((text, i) => ({ id: `review-${i + 1}`, text })),
    ...(CATEGORY_QUESTIONS[category] ?? []),
  ];
  if (!fromWording && !input.category) questions.unshift({ id: 'category', text: 'The wording names no category we check. Which category is this rule?' });

  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    categoryFromWording: fromWording === category,
    plainReading: plainReading(category, compiled),
    highlights: findHighlights(input.text, category, input.normativeMatches),
    values,
    questions,
    ai,
    aiNote,
    aiCall,
    clause: compiled,
  };
}

/**
 * Keeps only valid values; anything else is dropped rather than compiled. The lenient form of
 * `validateClauseValues` (same ranges), for the card preview while Legal is still typing.
 */
export function cleanOverrides(raw: unknown): RuleValueOverrides {
  return validateClauseValues(raw, { lenient: true });
}

export interface ImpactRepo {
  repoId: string;
  repoName: string;
  scanId: string | null;
  commitSha: string | null;
  /** When the scan the preview ran against finished (null when unknown or unscanned). */
  scannedAt: string | null;
  /** null when the repo has no completed scan to test against. */
  failures: number | null;
  places: Array<{ filePath: string; line: number; explanation: string }>;
}

/** Runs the prover with the draft clause against each repo's stored facts (the last scan of main). */
export async function impactPreview(
  clause: LegalClause,
  repos: Array<{
    repoId: string;
    repoName: string;
    scan: { id: string; commitSha: string; finishedAt?: string | null; facts: { sqlTables: unknown[]; astFindings: unknown[] } } | null;
  }>
): Promise<ImpactRepo[]> {
  const out: ImpactRepo[] = [];
  for (const r of repos) {
    if (!r.scan) {
      out.push({ repoId: r.repoId, repoName: r.repoName, scanId: null, commitSha: null, scannedAt: null, failures: null, places: [] });
      continue;
    }
    const { proofs } = await verifyRepositoryAgainstClauses([clause], r.scan.facts.sqlTables as SQLTableSchema[], r.scan.facts.astFindings as ASTFindingNode[]);
    const places = proofs
      .filter((p) => p.status === 'UNSAT_VIOLATION')
      .flatMap((p) => p.offendingLocations.map((l) => ({ filePath: l.filePath, line: l.line, explanation: l.explanation })));
    const unique = [...new Map(places.map((p) => [`${p.filePath}:${p.line}`, p])).values()];
    out.push({ repoId: r.repoId, repoName: r.repoName, scanId: r.scan.id, commitSha: r.scan.commitSha, scannedAt: r.scan.finishedAt ?? null, failures: unique.length, places: unique });
  }
  return out;
}

// ---------------------------------------------------------------- the web app's "analyze" screen

const OBLIGATION_RE = /\b(?:must not|must|shall not|shall|may not|may only|prohibited|is required|are required|required to|never)\b|অবশ্যই|করতে হবে|নিষিদ্ধ|যাবে না|বাধ্যতামূলক|লাগবে/giu;
const VALUE_RE =
  /\b(?:\d+(?:\.\d+)?|half an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty-eight|seventy-two|ninety)(?:\s*\(\d+\))?\s*(?:hours?|hrs?|minutes?|days?|weeks?|fortnights?|months?|years?)\b|\ba fortnight\b|\b\d{1,3}(?:\.\d+)?\s*(?:%|percent)|\b0\.\d+\b|[০-৯]+(?:\.[০-৯]+)?\s*(?:ঘণ্টা|ঘন্টা|দিন|শতাংশ)|[০-৯]\.[০-৯]+/giu;

/** A highlight on the analyze screen: the model's verified quote, a value, or an obligation word. */
export interface AnalyzeHighlight {
  start: number;
  end: number;
  kind: 'value' | 'obligation' | 'quote';
}

/** Words to highlight on the analyze screen: the model's verified quote, values, and obligation words. */
export function analyzeHighlights(text: string, quote: string | null): AnalyzeHighlight[] {
  const out: AnalyzeHighlight[] = [];
  if (quote) {
    const i = text.toLowerCase().indexOf(quote.toLowerCase());
    if (i >= 0) out.push({ start: i, end: i + quote.length, kind: 'quote' });
  }
  for (const m of text.matchAll(VALUE_RE)) out.push({ start: m.index!, end: m.index! + m[0].length, kind: 'value' });
  for (const m of text.matchAll(OBLIGATION_RE)) out.push({ start: m.index!, end: m.index! + m[0].length, kind: 'obligation' });
  // Keep the first of overlapping ranges (quote, then values, then words), then sort.
  const kept: AnalyzeHighlight[] = [];
  for (const h of out) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}

/** The one number a category enforces, as the analyze screen shows it. */
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

/** The analyze screen's card: one numeric value, the model call, highlights and the impact. */
export interface AnalyzedRule {
  category: RuleCategory;
  categoryLabel: string;
  inferredCategory: RuleCategory;
  value: RuleCardValue;
  ai: AiCallSummary;
  highlights: AnalyzeHighlight[];
  plainReading: string;
  reviewNotes: string[];
  impact: Array<{ repoId: string; repoFullName: string; commitSha: string; scannedAt: string | null; failing: number; locations: Array<{ filePath: string; line: number; explanation: string }> }>;
  compiled: { smtLib2: string; rego: string; formula: string };
  /** Values other than the number that still need Legal (for example allowed regions); approval waits for them. */
  openValues: CardValue[];
  /** The card's questions for Legal (review notes, the category's fixed questions). */
  questions: CardQuestion[];
}

/**
 * The analyze screen over `buildRuleCard`. The number is quote-checked as on the card: a model
 * value is used only when its quote is in the clause and the parser agrees; otherwise it is a
 * question. A value Legal sets wins. Impact runs against each repository's latest checked scan
 * of the default branch (repositories without one are left out).
 */
export async function analyzeRule(
  input: { workspaceId: string; text: string; category?: RuleCategory; values?: ClauseValues; key?: string },
  deps: { store: ProductStore; gov: GovernanceStore; ai: AiGateway }
): Promise<AnalyzedRule> {
  const text = input.text.trim();
  const key = input.key ?? 'DRAFT';
  const inferred = inferRuleCategoryFromProse(text);
  const category = input.category ?? inferred;
  const field = numericFieldFor(category);
  const legalValues = validateClauseValues(input.values ?? {}, { lenient: true });

  const card = await buildRuleCard({ text, key, category, overrides: legalValues, ai: { gateway: deps.ai, workspaceId: input.workspaceId } });

  let value: RuleCardValue = { field, unit: field ? FIELD_UNIT[field] : null, value: null, status: 'not_needed', question: null, parserValue: null, modelValue: null, quote: null };
  if (field) {
    const checked = card.ai?.checked ?? checkParserOnly(text, category);
    const shown = card.values.find((v) => v.field === field);
    if (checked) value = { ...value, value: checked.value, status: checked.status === 'accepted' ? 'confirmed' : 'question', question: checked.question, parserValue: checked.parserValue, modelValue: checked.modelValue, quote: checked.quote };
    if (shown?.source === 'legal' && typeof shown.value === 'number') value = { ...value, value: shown.value, status: 'set_by_legal', question: null };
  }

  // The preview enforces the number shown: when a confirmed value differs from the parser's compile, compile with it.
  let clause = card.clause;
  if (field && value.value !== null && clause.deontic.extractedParameters[field] !== value.value) {
    clause = compileClauseSync({ text, key, category, values: { ...legalValues, [field]: value.value } });
  }

  const preview = await impactPreview(
    clause,
    deps.store.listRepos(input.workspaceId).map((repo) => {
      const scan = deps.gov.latestBranchScan(repo.id, true);
      const facts = scan?.facts ? { sqlTables: scan.facts.sqlTables ?? [], astFindings: scan.facts.astFindings ?? [] } : null;
      return { repoId: repo.id, repoName: repo.fullName, scan: scan && facts ? { id: scan.id, commitSha: scan.commitSha, finishedAt: scan.finishedAt, facts } : null };
    })
  );
  const impact: AnalyzedRule['impact'] = preview
    .filter((r) => r.failures !== null)
    .map((r) => ({ repoId: r.repoId, repoFullName: r.repoName, commitSha: r.commitSha ?? '', scannedAt: r.scannedAt, failing: r.failures ?? 0, locations: r.places.slice(0, 20) }));

  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    inferredCategory: inferred,
    value,
    ai: card.aiCall,
    highlights: analyzeHighlights(text, value.status === 'confirmed' ? value.quote : null),
    plainReading: plainReading(clause),
    reviewNotes: clause.deontic.extractionProvenance?.reviewNotes ?? [],
    impact,
    compiled: { smtLib2: clause.compiled.smtLib2Snippet, rego: clause.compiled.opaRegoRule, formula: clause.compiled.deonticFormula },
    openValues: card.values.filter((v) => v.field !== field && v.source === 'question'),
    questions: card.questions,
  };
}
