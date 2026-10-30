import { fetchEurLexAmendments, fetchEurLexArticle } from '../regulations/eurLex.js';
import type {
  CompiledPolicyArtifacts,
  ComplianceFrameworkId,
  DeonticExtraction,
  DeonticExtractionProvenance,
  LegalClause,
  LiveRegulatoryFeedItem,
  RegulatoryMutationPreset,
  RuleCategory,
} from '../../shared/types.js';
import { runRealLlmInference } from '../services/realAiServiceMesh.js';

export { sha256Hex } from '../util/hash.js';
import { regoPolicyFor, type RegoBounds } from '../policy/regoPolicies.js';
import { treeSitterQueriesFor } from '../analyzer/treeSitter.js';

function regoBounds(b: ExtractedDeonticBounds): RegoBounds {
  return {
    maxRetentionHours: b.maxRetentionHours,
    requiresTenantIsolatedKeys: b.requiresTenantIsolatedKeys,
    requireEncryptionAtRest: b.requireEncryptionAtRest,
    forbidPlaintextLogging: b.forbidPlaintextLogging,
    minAiConfidenceThreshold: b.minAiConfidenceThreshold,
    requireHumanOversightGate: b.requireHumanOversightGate,
    requireImmutableAuditLog: true,
    requireCascadeErasure: b.requireCascadeErasure,
    allowedDataRegions: b.allowedDataRegions,
    requireConsentCheck: b.requireConsentCheck,
    maxBreachNotificationHours: b.maxBreachNotificationHours,
    requireDpia: b.requireDpia,
    forbidUnusedPiiFields: b.forbidUnusedPiiFields,
    allowedProcessingPurposes: b.allowedProcessingPurposes,
  };
}

const BANGLA_DIGIT_MAP: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

export function normalizeLegalProse(rawText: string): { normalized: string; lower: string } {
  const normalized = rawText.trim().replace(/[০-৯]/g, (d) => BANGLA_DIGIT_MAP[d] || d);
  return { normalized, lower: normalized.toLowerCase() };
}

export interface ExtractedDeonticBounds {
  maxRetentionHours: number;
  maxRetentionDays: number;
  temporalHit: boolean;
  temporalEvidence: string[];
  requiresTenantIsolatedKeys: boolean;
  requiredEncryptionAlgorithms: string[];
  forbidPlaintextLogging: boolean;
  requireCascadeErasure: boolean;
  minAiConfidenceThreshold: number;
  confidenceHit: boolean;
  requireHumanOversightGate: boolean;
  allowedDataRegions: string[];
  requireEncryptionAtRest: boolean;
  requireConsentCheck: boolean;
  maxBreachNotificationHours: number;
  requireDpia: boolean;
  forbidUnusedPiiFields: boolean;
  allowedProcessingPurposes: string[];
  provenance: DeonticExtractionProvenance;
}

const LLM_DEONTIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    maxRetentionHours: { type: 'number' },
    requiresTenantIsolatedKeys: { type: 'boolean' },
    forbidPlaintextLogging: { type: 'boolean' },
    requireCascadeErasure: { type: 'boolean' },
    minAiConfidenceThreshold: { type: 'number' },
    requireHumanOversightGate: { type: 'boolean' },
    allowedDataRegions: { type: 'array', items: { type: 'string' } },
    requireEncryptionAtRest: { type: 'boolean' },
  },
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, a: 1, an: 1,
};

const UNIT_WORDS =
  'hours?|hrs?|h|minutes?|mins?|days?|weeks?|wks?|fortnights?|months?|mos?|years?|yrs?|percent|ঘণ্টা|ঘন্টা|দিন';

const HALVABLE_UNITS = 'hours?|days?|weeks?|fortnights?|months?|years?';

/**
 * Rewrites halves as decimals before number words are read, so "half a day" is 0.5 day
 * (not "half 1 day"), and "one and a half days" / "a day and a half" are 1.5 days.
 */
export function normalizeFractionalDurations(lower: string): string {
  const word = Object.keys(NUMBER_WORDS).join('|');
  const value = (w: string) => (/^\d/.test(w) ? parseFloat(w) : (NUMBER_WORDS[w] ?? NaN));
  return lower
    .replace(new RegExp(`\\((\\d+(?:\\.\\d+)?)\\)\\s*(?=(?:${UNIT_WORDS})\\b)`, 'g'), '$1 ')
    .replace(new RegExp(`\\bhalf\\s+an?\\s+(${HALVABLE_UNITS})\\b`, 'g'), '0.5 $1')
    .replace(new RegExp(`\\b(\\d+(?:\\.\\d+)?|${word})\\s+and\\s+a\\s+half\\s+(${HALVABLE_UNITS})\\b`, 'g'), (m, n: string, unit: string) =>
      Number.isFinite(value(n)) ? `${value(n) + 0.5} ${unit}` : m
    )
    .replace(new RegExp(`\\b(\\d+(?:\\.\\d+)?|${word})\\s+(${HALVABLE_UNITS})\\s+and\\s+a\\s+half\\b`, 'g'), (m, n: string, unit: string) =>
      Number.isFinite(value(n)) ? `${value(n) + 0.5} ${unit}` : m
    );
}

/** Rewrites spelled-out counts before a unit ("seventy-two hours", "one week") as digits. */
export function normalizeNumberWords(lower: string): string {
  const word = Object.keys(NUMBER_WORDS).join('|');
  const re = new RegExp(`\\b((?:${word})(?:[\\s-]+(?:and[\\s-]+)?(?:${word}))*)\\s+(?=(?:${UNIT_WORDS})\\b)`, 'g');
  return lower.replace(re, (match, phrase: string) => {
    let total = 0;
    let current = 0;
    for (const w of phrase.split(/[\s-]+/).filter((t) => t && t !== 'and')) {
      const n = NUMBER_WORDS[w];
      if (n === undefined) return match;
      if (n === 100) current = (current || 1) * 100;
      else current += n;
    }
    total += current;
    return `${total} `;
  });
}

const TEMPORAL_UNITS: Array<{ re: RegExp; toHours: (n: number) => number; label: string }> = [
  { re: /(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)\b/g, toHours: (n) => n, label: 'hours' },
  { re: /(\d+(?:\.\d+)?)\s*(?:ঘণ্টা|ঘন্টা)/g, toHours: (n) => n, label: 'hours_bn' },
  { re: /(\d+(?:\.\d+)?)\s*(?:minutes|minute|mins|min)\b/g, toHours: (n) => n / 60, label: 'minutes' },
  { re: /(\d+(?:\.\d+)?)\s*(?:days|day)\b/g, toHours: (n) => n * 24, label: 'days' },
  { re: /(\d+(?:\.\d+)?)\s*(?:দিন)/g, toHours: (n) => n * 24, label: 'days_bn' },
  { re: /(\d+(?:\.\d+)?)\s*(?:weeks|week|wks|wk)\b/g, toHours: (n) => n * 24 * 7, label: 'weeks' },
  { re: /(\d+(?:\.\d+)?)\s*(?:fortnights|fortnight)\b/g, toHours: (n) => n * 24 * 14, label: 'fortnights' },
  { re: /(\d+(?:\.\d+)?)\s*(?:months|month|mos|mo)\b/g, toHours: (n) => n * 24 * 30, label: 'months' },
  { re: /(\d+(?:\.\d+)?)\s*(?:years|year|yrs|yr)\b/g, toHours: (n) => n * 24 * 365, label: 'years' },
];

/**
 * Finds every duration (minutes … years, English + Bangla, digits or number words) and
 * returns the strictest (shortest) one: for a purge/retention obligation the tightest
 * bound in the clause is the one code must satisfy. When several distinct durations
 * appear, a review note records which one was chosen.
 */
export function extractTemporalHoursFromProse(lower: string): {
  hours: number;
  hit: boolean;
  evidence: string[];
  reviewNotes: string[];
} {
  const found = findTemporalDurations(lower);
  if (found.length === 0) {
    return { hours: 720, hit: false, evidence: [], reviewNotes: [] };
  }
  found.sort((a, b) => a.hours - b.hours);
  const chosen = found[0];
  const distinct = [...new Set(found.map((f) => f.hours))];
  const reviewNotes =
    distinct.length > 1
      ? [
          `Several durations appear in the clause (${found.map((f) => f.text).join(', ')}); the strictest (${chosen.text} = ${chosen.hours}h) was used.`,
        ]
      : [];
  return { hours: chosen.hours, hit: true, evidence: [`${chosen.label}:${chosen.text}`], reviewNotes };
}

/** Every duration in the text, in hours, with the words it came from (input: lower-cased, Bangla digits as ASCII). */
export function findTemporalDurations(lower: string): Array<{ hours: number; text: string; label: string }> {
  const text = normalizeFractionalDurations(normalizeNumberWords(normalizeFractionalDurations(lower)));
  const found: Array<{ hours: number; text: string; label: string }> = [];
  for (const unit of TEMPORAL_UNITS) {
    for (const m of text.matchAll(unit.re)) {
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n) || n <= 0) continue;
      found.push({ hours: Math.round(unit.toHours(n) * 1000) / 1000, text: m[0].trim(), label: unit.label });
    }
  }
  return found;
}

/** Every confidence threshold in the text (0..1): decimals after a confidence word, and percentages. */
export function findConfidenceThresholds(lower: string): Array<{ value: number; text: string }> {
  const thresholds: Array<{ value: number; text: string }> = [];
  for (const m of lower.matchAll(
    /(?:threshold|confidence|score|below|minimum|at least|আত্মবিশ্বাস|স্কোর|কমপক্ষে)[^0-9]{0,40}?(0\.\d+)/g
  )) {
    thresholds.push({ value: parseFloat(m[1]), text: m[1] });
  }
  for (const m of normalizeNumberWords(lower).matchAll(/(\d{1,3}(?:\.\d+)?)\s*(?:%|শতাংশ|percent)/g)) {
    const pct = parseFloat(m[1]);
    if (pct > 0 && pct <= 100) thresholds.push({ value: pct / 100, text: m[0] });
  }
  return thresholds;
}

/** Display names for clauses created from free text or the regulatory feed. */
export const FRAMEWORK_DISPLAY_NAMES: Record<ComplianceFrameworkId, string> = {
  ENTERPRISE_DPA: 'Enterprise DPA',
  GDPR: 'EU General Data Protection Regulation',
  EU_AI_ACT: 'EU Artificial Intelligence Act',
  HIPAA: 'HIPAA',
  CCPA_CPRA: 'CCPA / CPRA',
};

export function inferRuleCategoryFromProse(
  rawText: string,
  fallback: RuleCategory = 'RETENTION_AND_TENANT_KMS'
): RuleCategory {
  const { lower } = normalizeLegalProse(rawText);
  // Governance categories first: their trigger phrases are specific.
  if (/personal data breach|breach notification|notify the supervisory authority|article 33\b/.test(lower)) return 'BREACH_NOTIFICATION';
  if (/impact assessment|\bdpia\b|article 35\b/.test(lower)) return 'DPIA_REQUIRED';
  if (/data minimi[sz]ation|adequate, relevant and limited|article 5\s*\(1\)\s*\(c\)/.test(lower)) return 'DATA_MINIMISATION';
  if (/purpose limitation|specified, explicit and legitimate purposes?|article 5\s*\(1\)\s*\(b\)|only for the purposes? of/.test(lower)) return 'PURPOSE_LIMITATION';
  if (/\bconsent\b|lawful basis|legal basis|article 6\b|article 7\b/.test(lower)) return 'CONSENT_LAWFUL_BASIS';

  // The six code-checkable categories share vocabulary ("prohibited", "logging", "মুছে ফেলতে হবে"),
  // so a single matching word must not decide. Each category collects weighted evidence and the
  // strongest wins; ties keep the order below.
  let best: RuleCategory | null = null;
  let bestScore = 0;
  for (const [category, score] of scoreCoreCategories(lower)) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best ?? fallback;
}

/**
 * Weighted keyword evidence (English and Bangla) for the code-checkable categories, in tie-break
 * order. `lower` is normalized prose: lower case, Bangla digits converted to ASCII.
 */
function scoreCoreCategories(lower: string): Array<[RuleCategory, number]> {
  const has = (re: RegExp) => re.test(lower);
  const mentionsLogging = has(/\blog(?:s|ged|ging|gers?)?\b|stdout|observability|লগ/);
  const forbids = has(/prohibit|forbid|shall not|must not|may not|never|নিষিদ্ধ|যাবে না/);
  const plaintext = has(/unredacted|plain ?text|redact|\bmask|রিড্যাক্ট|অরক্ষিত/);
  const retention = has(/retention|retain|purge|deleted within|erased within|\bttl\b|রিটেনশন|মধ্যে[^।]{0,80}মুছে/);
  const duration = extractTemporalHoursFromProse(lower).hit;
  const encryption = has(/encrypt(?:ed|ion)? at rest|aes-?256|column.?encrypt|এনক্রিপ্ট/);
  const tenantKeys = has(
    /tenant[- ]isolated|tenant[- ]specific|per[- ]tenant|customer[- ]managed\s+key|tenant_kms|টেন্যান্ট|পৃথক\s*কী|আইসোলেটেড\s*কী|কেএমএস/
  );
  return [
    ['PII_LOGGING_BAN', mentionsLogging ? 2 + (forbids ? 1 : 0) + (plaintext ? 2 : 0) : 0],
    [
      'AI_HUMAN_IN_THE_LOOP',
      (has(/human[- ]in[- ]the[- ]loop|human oversight|human review|overseen by natural persons|মানব তদারকি|হিউম্যান/) ? 3 : 0) +
        (has(/article 14\b|\bai act\b|high-risk ai|অনুচ্ছেদ 14/) ? 2 : 0) +
        (has(/confidence|automated decision|autonomous|আত্মবিশ্বাস|স্বয়ংক্রিয়/) ? 1 : 0),
    ],
    [
      'CROSS_BORDER_TRANSFER',
      (has(/cross[- ]border|third[- ]countr|article 44\b|chapter v\b|আন্তঃসীমান্ত|দেশের বাইরে|তৃতীয় দেশ/) ? 3 : 0) +
        (has(/transfer|replicat|স্থানান্তর|রেপ্লিকেশন/) ? 1 : 0) +
        (has(/\b[a-z]{2}-[a-z]+-\d\b|\beea\b|sovereign|residency|রিজিয়ন|সার্বভৌম/) ? 1 : 0),
    ],
    [
      'RIGHT_TO_ERASURE_CASCADE',
      (has(/right to (?:be )?forgotten|right to erasure|erasure of personal data|cascad|delete all linked|article 17\b/) ? 3 : 0) +
        (has(/erasure|\berase\b|মুছে ফেল/) ? 1 : 0),
    ],
    ['RETENTION_AND_TENANT_KMS', (retention ? 2 : 0) + (duration ? 2 : 0) + (tenantKeys ? 1 : 0)],
    ['ENCRYPTION_AT_REST', encryption && !retention && !duration ? 2 : 0],
  ];
}

/** "need not", "not required", "optional", "may (be)" directly governing a phrase. */
const NEGATED_BEFORE = /(need not|needn't|not required to|is not required|are not required|shall not be required|not obliged to|optional(?:ly)?|may)\s+(?:\w+\s+){0,4}$/;
const NEGATED_AFTER = /^\s*(?:is|are)\s+(?:not required|optional|not mandatory)/;

function phraseIsNegated(lower: string, re: RegExp): boolean {
  const m = lower.match(re);
  if (!m || m.index == null) return false;
  const before = lower.slice(Math.max(0, m.index - 60), m.index);
  const after = lower.slice(m.index + m[0].length, m.index + m[0].length + 40);
  return NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after);
}

const TENANT_KMS_RE =
  /tenant[- ]isolated|tenant[- ]specific|per[- ]tenant|customer[- ]managed\s+key|tenant_kms|টেন্যান্ট|পৃথক\s*কী|আইসোলেটেড\s*কী|কেএমএস/i;
const LOG_BAN_RE =
  /prohibit|shall not log|never log|forbid|unredacted|plaintext.*log|mask|redact|লগ.*নিষিদ্ধ|লগিং.*নিষিদ্ধ|অরক্ষিত.*লগ|প্রকাশ করা যাবে না|রিড্যাক্ট/i;
const LOG_PERMITTED_RE = /(logging|log|logged)[^.;]{0,60}\b(is|are)\s+(permitted|allowed)|\bmay\s+(be\s+)?log/i;

/** Permitted purposes: quoted names, or the list after "only for (the purposes of)". */
export function extractPurposes(text: string): string[] {
  const slug = (p: string) => p.trim().toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const quoted = [...text.matchAll(/["“']([A-Za-z][A-Za-z0-9 _-]{2,40})["”']/g)].map((m) => slug(m[1]));
  if (quoted.length) return [...new Set(quoted)];
  const m = /only for (?:the )?(?:purposes? of )?([^.;]+)/i.exec(text);
  if (!m) return [];
  return [...new Set(m[1].split(/,|\band\b|\bor\b/).map(slug).filter((p) => p.length > 2))];
}

export function extractDeonticBoundsFromProse(
  rawText: string,
  category: RuleCategory
): ExtractedDeonticBounds {
  const { normalized, lower } = normalizeLegalProse(rawText);
  const temporal = extractTemporalHoursFromProse(lower);
  const reviewNotes = [...temporal.reviewNotes];
  const maxRetentionHours = temporal.hours;
  const maxRetentionDays = Math.max(1, Math.round((maxRetentionHours / 24) * 10) / 10);

  const tenantMentioned = TENANT_KMS_RE.test(normalized);
  const tenantNegated = tenantMentioned && phraseIsNegated(lower, new RegExp(TENANT_KMS_RE.source, 'i'));
  if (tenantNegated) {
    reviewNotes.push('The tenant-isolated key requirement appears negated ("need not", "optional", …); it was not required.');
  }
  const requiresTenantIsolatedKeys = tenantMentioned && !tenantNegated;

  const requiredEncryptionAlgorithms: string[] = ['AES-256-GCM'];
  if (requiresTenantIsolatedKeys) {
    requiredEncryptionAlgorithms.push('TENANT-ISOLATED-KMS-ENVELOPE');
  }

  const loggingPermitted = LOG_PERMITTED_RE.test(lower) && !/prohibit|shall not|never|forbid/i.test(lower);
  if (loggingPermitted) {
    reviewNotes.push('The clause permits logging; no plaintext-logging prohibition was compiled.');
  }
  const forbidPlaintextLogging =
    !loggingPermitted && (LOG_BAN_RE.test(normalized) || category === 'PII_LOGGING_BAN');

  const requireCascadeErasure =
    /cascade|erasure|right to be forgotten|delete all linked|article 17|মুছে ফেলতে হবে|সম্পূর্ণরূপে মুছে/i.test(
      normalized
    ) || category === 'RIGHT_TO_ERASURE_CASCADE';

  const encryptionRe = /encrypt(?:ed|ion)? at rest|encrypted at rest|aes-256|@encrypted/i;
  const encryptionNegated = encryptionRe.test(normalized) && phraseIsNegated(lower, encryptionRe);
  const requireEncryptionAtRest =
    !encryptionNegated &&
    (encryptionRe.test(normalized) || category === 'ENCRYPTION_AT_REST' || category === 'RETENTION_AND_TENANT_KMS');

  // Confidence: every decimal after a confidence keyword and every percentage; the
  // strictest (highest) gate wins.
  const thresholds = findConfidenceThresholds(lower);
  let minAiConfidenceThreshold = 0.7;
  const confidenceHit = thresholds.length > 0;
  if (confidenceHit) {
    thresholds.sort((a, b) => b.value - a.value);
    minAiConfidenceThreshold = thresholds[0].value;
    const distinct = [...new Set(thresholds.map((t) => t.value))];
    if (distinct.length > 1) {
      reviewNotes.push(
        `Several confidence values appear (${distinct.join(', ')}); the strictest (${minAiConfidenceThreshold}) was used.`
      );
    }
  }

  const requireHumanOversightGate =
    /human[- ]in[- ]the[- ]loop|human oversight|human review|manual approval|article 14|মানব তদারকি|মানুষের অনুমোদন|হিউম্যান/i.test(
      normalized
    ) || category === 'AI_HUMAN_IN_THE_LOOP';

  const allowedDataRegions: string[] = ['eu-central-1', 'eu-west-1'];
  if (
    !/strict eu|eea only|prohibit.*us-east|non-adequate|sovereign eu|দেশের বাইরে|স্থানান্তর নিষিদ্ধ|সার্বভৌম/i.test(
      normalized
    ) &&
    category === 'CROSS_BORDER_TRANSFER'
  ) {
    if (/allow.*us-east-1|standard contractual clauses|অনুমোদিত.*us-east-1/i.test(normalized)) {
      allowedDataRegions.push('us-east-1');
    }
  }

  // "may be processed only with consent" is a condition, not a permission: only explicit
  // waivers ("consent is not required", "need not obtain consent") negate the obligation.
  const consentWaived = /(?:need not|not required to|no need to)\s+(?:\w+\s+){0,3}(?:consent|lawful basis)|(?:consent|lawful basis)\s+(?:is|are)\s+(?:not required|optional|not needed)|without (?:requiring|the need for) (?:consent|a lawful basis)/i.test(lower);
  const requireConsentCheck = category === 'CONSENT_LAWFUL_BASIS' && !consentWaived;
  if (category === 'CONSENT_LAWFUL_BASIS' && !requireConsentCheck) reviewNotes.push('The consent requirement appears negated; no consent check was required.');
  const maxBreachNotificationHours = category === 'BREACH_NOTIFICATION' && temporal.hit ? temporal.hours : 72;
  const requireDpia = category === 'DPIA_REQUIRED' || /impact assessment|\bdpia\b/i.test(lower);
  const forbidUnusedPiiFields = category === 'DATA_MINIMISATION';
  const allowedProcessingPurposes = category === 'PURPOSE_LIMITATION' ? extractPurposes(normalized) : [];
  if (category === 'PURPOSE_LIMITATION' && allowedProcessingPurposes.length === 0) {
    reviewNotes.push('No list of permitted purposes was found; only a declared processing purpose is required.');
  }

  const needsNumeric =
    category === 'RETENTION_AND_TENANT_KMS' || category === 'AI_HUMAN_IN_THE_LOOP' || category === 'BREACH_NOTIFICATION';
  const missingNumeric =
    (category === 'RETENTION_AND_TENANT_KMS' && !temporal.hit) ||
    (category === 'AI_HUMAN_IN_THE_LOOP' && !confidenceHit) ||
    (category === 'BREACH_NOTIFICATION' && !temporal.hit);

  return {
    maxRetentionHours,
    maxRetentionDays,
    temporalHit: temporal.hit,
    temporalEvidence: temporal.evidence,
    requiresTenantIsolatedKeys,
    requiredEncryptionAlgorithms,
    forbidPlaintextLogging,
    requireCascadeErasure,
    minAiConfidenceThreshold,
    confidenceHit,
    requireHumanOversightGate,
    allowedDataRegions,
    requireEncryptionAtRest,
    requireConsentCheck,
    maxBreachNotificationHours,
    requireDpia,
    forbidUnusedPiiFields,
    allowedProcessingPurposes,
    provenance: {
      method: needsNumeric && missingNumeric ? 'DETERMINISTIC_DEFAULT' : 'DETERMINISTIC_PARSER',
      evidence: [...temporal.evidence, ...(confidenceHit ? [`confidence:${minAiConfidenceThreshold}`] : [])],
      ...(reviewNotes.length > 0 ? { reviewNotes } : {}),
    },
  };
}

/**
 * Validates LLM output and uses it only to fill the numeric bound the deterministic
 * parser could not find. Out-of-range or malformed values are rejected; booleans and
 * regions always come from the deterministic parser.
 */
export function mergeLlmBounds(
  base: ExtractedDeonticBounds,
  parsed: Record<string, unknown>,
  model: string,
  latencyMs: number
): ExtractedDeonticBounds {
  const next = { ...base };
  const accepted: string[] = [];
  const rejected: string[] = [];

  if (!base.temporalHit && parsed.maxRetentionHours !== undefined) {
    const h = Number(parsed.maxRetentionHours);
    if (Number.isFinite(h) && h > 0 && h <= 24 * 365 * 100) {
      next.maxRetentionHours = Math.round(h * 1000) / 1000;
      next.maxRetentionDays = Math.max(1, Math.round((h / 24) * 10) / 10);
      next.temporalHit = true;
      accepted.push(`maxRetentionHours=${next.maxRetentionHours}`);
    } else {
      rejected.push(`maxRetentionHours=${String(parsed.maxRetentionHours)}`);
    }
  }
  if (!base.confidenceHit && parsed.minAiConfidenceThreshold !== undefined) {
    let c = Number(parsed.minAiConfidenceThreshold);
    if (Number.isFinite(c) && c > 1 && c <= 100) c = c / 100;
    if (Number.isFinite(c) && c > 0 && c <= 1) {
      next.minAiConfidenceThreshold = c;
      next.confidenceHit = true;
      accepted.push(`minAiConfidenceThreshold=${c}`);
    } else {
      rejected.push(`minAiConfidenceThreshold=${String(parsed.minAiConfidenceThreshold)}`);
    }
  }
  if (accepted.length === 0) {
    return {
      ...base,
      provenance: {
        ...base.provenance,
        llmModel: model,
        llmLatencyMs: latencyMs,
        llmRejectedReason: rejected.length > 0 ? `out_of_range:${rejected.join(';')}` : 'no_usable_fields',
      },
    };
  }
  next.provenance = {
    method: 'LLM_JSON_FALLBACK',
    evidence: [...base.provenance.evidence, ...accepted.map((a) => `llm:${a}`)],
    llmModel: model,
    llmLatencyMs: latencyMs,
    ...(rejected.length > 0 ? { llmRejectedReason: `out_of_range:${rejected.join(';')}` } : {}),
    reviewNotes: [
      ...(base.provenance.reviewNotes || []),
      `An LLM supplied ${accepted.join(', ')}; confirm against the clause text.`,
    ],
  };
  return next;
}

export async function extractDeonticBoundsWithLlmFallback(
  rawText: string,
  category: RuleCategory
): Promise<ExtractedDeonticBounds> {
  const deterministic = extractDeonticBoundsFromProse(rawText, category);
  const needsFallback =
    (category === 'RETENTION_AND_TENANT_KMS' && !deterministic.temporalHit) ||
    (category === 'AI_HUMAN_IN_THE_LOOP' && !deterministic.confidenceHit);
  if (!needsFallback) {
    return deterministic;
  }

  try {
    const llm = await runRealLlmInference({
      prompt: `Extract deontic compliance bounds as JSON from this legal clause.\nCategory: ${category}\nClause:\n${rawText}\n\nReturn only JSON with maxRetentionHours (hours, converting minutes/days/weeks/months/years) and minAiConfidenceThreshold (0-1).`,
      systemPrompt:
        'You are LexCompiler deontic extractor. Output a single JSON object matching the schema. Convert any time unit to hours.',
      jsonSchema: LLM_DEONTIC_SCHEMA,
      maxTokens: 220,
      temperature: 0,
      timeoutMs: 8000,
      task: 'compiler-fallback',
    });
    if (!llm.available) {
      return {
        ...deterministic,
        provenance: { ...deterministic.provenance, llmRejectedReason: 'llm_unavailable' },
      };
    }
    const jsonMatch = llm.responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        ...deterministic,
        provenance: {
          ...deterministic.provenance,
          llmModel: llm.model,
          llmLatencyMs: llm.totalDurationMs,
          llmRejectedReason: 'no_json_object',
        },
      };
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return mergeLlmBounds(deterministic, parsed, llm.model, llm.totalDurationMs);
  } catch (err) {
    return {
      ...deterministic,
      provenance: {
        ...deterministic.provenance,
        llmRejectedReason: err instanceof Error ? err.message : 'llm_unavailable',
      },
    };
  }
}

/**
 * Neuro-Symbolic Deontic Legal Deconstruction & Policy Synthesis Compiler.
 * Dynamically parses natural-language legal clauses or contract amendments into:
 * 1. Deontic Intermediate Representation (Obligations O, Prohibitions F, Permissions P)
 * 2. First-Order Predicate Logic
 * 3. Executable SMT-LIB2 scripts for Microsoft Z3
 * 4. Open Policy Agent (OPA / Rego) rules
 * 5. Tree-sitter / AST structural query patterns
 */
export function compileFromBounds(
  bounds: ExtractedDeonticBounds,
  category: RuleCategory,
  clauseId: string,
  citation: string
): { deontic: DeonticExtraction; compiled: CompiledPolicyArtifacts } {
  const {
    maxRetentionHours,
    maxRetentionDays,
    requiresTenantIsolatedKeys,
    requiredEncryptionAlgorithms,
    forbidPlaintextLogging,
    requireCascadeErasure,
    minAiConfidenceThreshold,
    requireHumanOversightGate,
    allowedDataRegions,
    requireEncryptionAtRest,
    provenance,
  } = bounds;

  if (category === 'RETENTION_AND_TENANT_KMS') {
    const deontic: DeonticExtraction = {
      modality: 'OBLIGATION',
      deonticOperatorSymbol: 'O(φ)',
      actor: 'Data Controller / Ingestion & Storage Pipeline',
      regulatedAction: `Encrypt PII at rest${
        requiresTenantIsolatedKeys ? ' with Tenant-Isolated KMS Keys' : ''
      } & purge within ${maxRetentionHours} hours (${maxRetentionDays}d)`,
      targetDataScope: ['postgres_pii_schema', 'fastapi_patient_endpoint', 'redis_cache_worker'],
      normativeCondition: `∀ entity ∈ PII_Store: EncryptedAtRest(entity) = true ∧ ${
        requiresTenantIsolatedKeys ? 'TenantKeyIsolated(entity) = true ∧ ' : ''
      }RetentionTTL_Hours(entity) ≤ ${maxRetentionHours}`,
      formalPredicateSummary: `O(EncryptedAtRest ∧ ${
        requiresTenantIsolatedKeys ? 'TenantIsolatedKMS ∧ ' : ''
      }TTL_Hours ≤ ${maxRetentionHours})`,
      extractedParameters: {
        maxRetentionHours,
        maxRetentionDays,
        requiresTenantIsolatedKeys,
        requiredEncryptionAlgorithms,
        requireCascadeErasure,
        requireEncryptionAtRest,
      },
      extractionProvenance: provenance,
    };

    const compiled: CompiledPolicyArtifacts = {
      deonticFormula: `O(∀x ∈ PII_Pipeline : Encrypted(x) ∧ ${
        requiresTenantIsolatedKeys ? 'TenantKMS(x) ∧ ' : ''
      }PurgeTTL_Hours(x) ≤ ${maxRetentionHours})`,
      firstOrderLogic: `∀node ∈ {PostgresSchema, FastAPIEndpoint, RedisWorker} : StoresPII(node) → (IsEncrypted(node) ∧ (${
        requiresTenantIsolatedKeys ? 'HasTenantKeyIsolation(node)' : 'True'
      }) ∧ (RetentionHours(node) ≤ ${maxRetentionHours}))`,
      smtLib2Snippet: `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_LIA)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)

(declare-const statutory_max_ttl_hours Int)
(declare-const statutory_requires_tenant_kms Bool)
(declare-const postgres_encrypted_at_rest Bool)
(declare-const postgres_tenant_kms_isolated Bool)
(declare-const postgres_retention_hours Int)
(declare-const fastapi_uses_tenant_kms Bool)
(declare-const redis_worker_ttl_hours Int)

; Statutory Normative Axioms (${citation})
(assert (! (= statutory_max_ttl_hours ${maxRetentionHours}) :named law_max_retention_${maxRetentionHours}h))
(assert (! (= statutory_requires_tenant_kms ${requiresTenantIsolatedKeys}) :named law_requires_tenant_kms))

; Universal Compliance Invariants
(assert (! (= postgres_encrypted_at_rest true) :named inv_postgres_encrypted_at_rest))
(assert (! (=> statutory_requires_tenant_kms (= postgres_tenant_kms_isolated true)) :named inv_postgres_tenant_key_isolation))
(assert (! (<= postgres_retention_hours statutory_max_ttl_hours) :named inv_postgres_retention_bound))
(assert (! (=> statutory_requires_tenant_kms (= fastapi_uses_tenant_kms true)) :named inv_fastapi_tenant_kms_envelope))
(assert (! (<= redis_worker_ttl_hours statutory_max_ttl_hours) :named inv_redis_ttl_within_${maxRetentionHours}h))`,
      opaRegoRule: regoPolicyFor(category, regoBounds(bounds), citation),
      astPatternQuery: treeSitterQueriesFor(category),
    };

    return { deontic, compiled };
  }

  if (category === 'PII_LOGGING_BAN') {
    const deontic: DeonticExtraction = {
      modality: 'PROHIBITION',
      deonticOperatorSymbol: 'F(φ)',
      actor: 'Application Telemetry & API Logging Middleware',
      regulatedAction: 'Emit unredacted PII/PHI fields (ssn, email, diagnosis) to stdout or telemetry log sinks',
      targetDataScope: ['ssn', 'diagnosis_code', 'email', 'full_name'],
      normativeCondition: `∀ call ∈ AST_LoggerCalls : ¬ContainsPlaintextPII(call.arguments)`,
      formalPredicateSummary: `F(PlaintextPIILogging) ≡ O(RedactPIIBeforeLogSink)`,
      extractedParameters: {
        forbidPlaintextLogging,
      },
      extractionProvenance: provenance,
    };

    const compiled: CompiledPolicyArtifacts = {
      deonticFormula: `F(∃sink ∈ LogSinks, ∃field ∈ PII_Fields : WritesUnredacted(sink, field))`,
      firstOrderLogic: `∀call ∈ AST(LoggerCall) : ForbidPlaintextLog → (LogsPlaintextPII(call) = false)`,
      smtLib2Snippet: `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_UF)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)

(declare-const law_forbids_plaintext_pii_logs Bool)
(declare-const fastapi_logs_plaintext_pii Bool)

(assert (! (= law_forbids_plaintext_pii_logs ${forbidPlaintextLogging}) :named law_hipaa_gdpr_no_pii_logs))
(assert (! (=> law_forbids_plaintext_pii_logs (= fastapi_logs_plaintext_pii false)) :named inv_zero_plaintext_pii_in_logs))`,
      opaRegoRule: regoPolicyFor(category, regoBounds(bounds), citation),
      astPatternQuery: treeSitterQueriesFor(category),
    };

    return { deontic, compiled };
  }

  if (category === 'AI_HUMAN_IN_THE_LOOP') {
    const scaledThreshold = Math.round(minAiConfidenceThreshold * 100);
    const deontic: DeonticExtraction = {
      modality: 'OBLIGATION',
      deonticOperatorSymbol: 'O(φ)',
      actor: 'High-Risk AI Automated Decision Engine',
      regulatedAction: `Enforce Human-in-the-Loop review gate when model confidence < ${minAiConfidenceThreshold.toFixed(
        2
      )} (${scaledThreshold}%) & write immutable audit log`,
      targetDataScope: ['services/ai_credit_triage.ts', 'evaluatePatientRiskAndCredit'],
      normativeCondition: `∀ decision ∈ HighRiskAI : HumanOversightGate(decision) = true ∧ ConfidenceThreshold(decision) ≥ ${scaledThreshold}% ∧ ImmutableAudit(decision) = true`,
      formalPredicateSummary: `O(HumanOversightGate ∧ ConfidenceGate ≥ ${scaledThreshold}% ∧ AuditLog)`,
      extractedParameters: {
        minAiConfidenceThreshold,
        requireHumanOversightGate,
        requireImmutableAuditLog: true,
      },
      extractionProvenance: provenance,
    };

    const compiled: CompiledPolicyArtifacts = {
      deonticFormula: `O(∀d ∈ HighRiskAIDecisions : (Confidence(d) < ${minAiConfidenceThreshold.toFixed(
        2
      )} → RequireHumanApproval(d)) ∧ ImmutableAuditLog(d))`,
      firstOrderLogic: `∀fn ∈ AIInferenceNodes : HasHumanGate(fn) ∧ (ConfiguredConfidencePct(fn) ≥ ${scaledThreshold}) ∧ WritesAuditLog(fn)`,
      smtLib2Snippet: `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_LIA)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)

(declare-const statutory_min_confidence_pct Int)
(declare-const ai_engine_confidence_gate_pct Int)
(declare-const ai_engine_has_human_oversight Bool)
(declare-const ai_engine_writes_audit_log Bool)

(assert (! (= statutory_min_confidence_pct ${scaledThreshold}) :named law_eu_ai_act_min_confidence_${scaledThreshold}pct))
(assert (! (= ai_engine_has_human_oversight true) :named inv_eu_ai_act_human_oversight_gate))
(assert (! (>= ai_engine_confidence_gate_pct statutory_min_confidence_pct) :named inv_eu_ai_act_confidence_threshold))
(assert (! (= ai_engine_writes_audit_log true) :named inv_eu_ai_act_article12_audit_log))`,
      opaRegoRule: regoPolicyFor(category, regoBounds(bounds), citation),
      astPatternQuery: treeSitterQueriesFor(category),
    };

    return { deontic, compiled };
  }

  if (category === 'ENCRYPTION_AT_REST') {
    const deontic: DeonticExtraction = {
      modality: 'OBLIGATION',
      deonticOperatorSymbol: 'O(φ)',
      actor: 'Data Controller / Persistent Storage Pipeline',
      regulatedAction: `Encrypt all PII/PHI columns at rest${
        requiresTenantIsolatedKeys ? ' with tenant-isolated KMS envelopes' : ' with AES-256-GCM'
      }`,
      targetDataScope: ['sql_pii_columns', 'object_storage_blobs'],
      normativeCondition: `∀ col ∈ PII_Columns : EncryptedAtRest(col) = true${
        requiresTenantIsolatedKeys ? ' ∧ TenantKeyIsolated(col) = true' : ''
      }`,
      formalPredicateSummary: `O(EncryptedAtRest${
        requiresTenantIsolatedKeys ? ' ∧ TenantIsolatedKMS' : ''
      })`,
      extractedParameters: {
        requiresTenantIsolatedKeys,
        requiredEncryptionAlgorithms,
        requireEncryptionAtRest: true,
      },
      extractionProvenance: provenance,
    };
    const compiled: CompiledPolicyArtifacts = {
      deonticFormula: `O(∀x ∈ PII_Store : EncryptedAtRest(x) = true)`,
      firstOrderLogic: `∀table ∈ SQLSchema : ContainsPII(table) → UnencryptedPiiColumns(table) = ∅`,
      smtLib2Snippet: `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_UF)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)

(declare-const statutory_requires_encryption_at_rest Bool)
(declare-const postgres_encrypted_at_rest Bool)
(declare-const postgres_tenant_kms_isolated Bool)
(declare-const statutory_requires_tenant_kms Bool)

(assert (! (= statutory_requires_encryption_at_rest true) :named law_encryption_at_rest))
(assert (! (= statutory_requires_tenant_kms ${requiresTenantIsolatedKeys}) :named law_requires_tenant_kms))
(assert (! (=> statutory_requires_encryption_at_rest (= postgres_encrypted_at_rest true)) :named inv_all_pii_columns_encrypted))
(assert (! (=> statutory_requires_tenant_kms (= postgres_tenant_kms_isolated true)) :named inv_tenant_kms_for_encrypted_store))`,
      opaRegoRule: regoPolicyFor(category, regoBounds(bounds), citation),
      astPatternQuery: treeSitterQueriesFor(category),
    };
    return { deontic, compiled };
  }

  if (category === 'RIGHT_TO_ERASURE_CASCADE') {
    const deontic: DeonticExtraction = {
      modality: 'OBLIGATION',
      deonticOperatorSymbol: 'O(φ)',
      actor: 'Data Controller / Relational Persistence Layer',
      regulatedAction:
        'Cascade delete all linked PII/PHI child records when a data subject erasure request is executed (GDPR Art. 17)',
      targetDataScope: ['sql_foreign_keys', 'erasure_handlers'],
      normativeCondition: `∀ fk ∈ ForeignKeys(PII_Parent) : OnDeleteCascade(fk) = true`,
      formalPredicateSummary: `O(ErasureCascade)`,
      extractedParameters: {
        requireCascadeErasure: true,
      },
      extractionProvenance: provenance,
    };
    const compiled: CompiledPolicyArtifacts = {
      deonticFormula: `O(∀child ∈ DependentPII : ON_DELETE_CASCADE(child, parent))`,
      firstOrderLogic: `∀t ∈ SQLTables : StoresPII(t) → HasErasureCascade(t)`,
      smtLib2Snippet: `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_UF)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)

(declare-const statutory_requires_cascade_erasure Bool)
(declare-const postgres_has_cascade_erasure Bool)

(assert (! (= statutory_requires_cascade_erasure true) :named law_gdpr_art17_cascade_erasure))
(assert (! (=> statutory_requires_cascade_erasure (= postgres_has_cascade_erasure true)) :named inv_fk_on_delete_cascade))`,
      opaRegoRule: regoPolicyFor(category, regoBounds(bounds), citation),
      astPatternQuery: treeSitterQueriesFor(category),
    };
    return { deontic, compiled };
  }

  const governance = compileGovernanceCategory(bounds, category, clauseId, citation);
  if (governance) return governance;

  // CROSS_BORDER_TRANSFER (explicit branch; never a silent fallthrough for other categories)
  const allowsUsEast = allowedDataRegions.includes('us-east-1');
  const deontic: DeonticExtraction = {
    modality: 'PROHIBITION',
    deonticOperatorSymbol: 'F(φ)',
    actor: 'Cross-Border Telemetry & Replication Service',
    regulatedAction: `Prohibit outbound PII replication outside approved jurisdictions (${allowedDataRegions.join(
      ', '
    )})`,
    targetDataScope: ['services/cross_border_sync.ts', 'replicatePatientTelemetry'],
    normativeCondition: `∀ egress ∈ DataEgressEdges : TargetRegion(egress) ∈ {${allowedDataRegions.join(
      ', '
    )}}`,
    formalPredicateSummary: `F(TargetRegion ∉ {${allowedDataRegions.join(', ')}})`,
    extractedParameters: {
      allowedDataRegions,
    },
    extractionProvenance: provenance,
  };

  const compiled: CompiledPolicyArtifacts = {
    deonticFormula: `F(∃e ∈ EgressStreams : ContainsPII(e) ∧ Region(e) ∉ {${allowedDataRegions.join(
      ', '
    )}})`,
    firstOrderLogic: `∀egress ∈ OutboundSync : IsApprovedEUJurisdiction(TargetRegion(egress))`,
    smtLib2Snippet: `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_UF)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)

(declare-const statutory_allows_non_eu_egress Bool)
(declare-const egress_targets_non_eu_region Bool)

(assert (! (= statutory_allows_non_eu_egress ${allowsUsEast}) :named law_gdpr_ch5_sovereign_residency))
(assert (! (=> (not statutory_allows_non_eu_egress) (= egress_targets_non_eu_region false)) :named inv_gdpr_art44_no_unapproved_egress))`,
    opaRegoRule: regoPolicyFor(category, regoBounds(bounds), citation),
    astPatternQuery: treeSitterQueriesFor(category),
  };

  return { deontic, compiled };
}

/** Deontic text, FOL and SMT-LIB2 summary for the GDPR governance categories. */
function compileGovernanceCategory(
  bounds: ExtractedDeonticBounds,
  category: RuleCategory,
  clauseId: string,
  citation: string
): { deontic: DeonticExtraction; compiled: CompiledPolicyArtifacts } | null {
  const b = bounds;
  const header = `; LexCompiler SMT-LIB2 Synthesis for ${citation} (${clauseId})
(set-logic QF_LIA)
(set-option :produce-models true)
(set-option :produce-unsat-cores true)
`;
  const spec: Record<string, { modality: DeonticExtraction['modality']; op: DeonticExtraction['deonticOperatorSymbol']; actor: string; action: string; scope: string[]; condition: string; formula: string; fol: string; smt: string; params: DeonticExtraction['extractedParameters'] }> = {
    CONSENT_LAWFUL_BASIS: {
      modality: 'OBLIGATION', op: 'O(φ)', actor: 'Data Controller / Request Handlers',
      action: 'Verify consent or another lawful basis before processing personal data (GDPR Art. 6–7)',
      scope: ['pii_entrypoints'], condition: '∀ h ∈ PIIEntryPoints : ConsentChecked(h)',
      formula: 'O(∀h ∈ PIIEntryPoints : ConsentChecked(h))', fol: '∀h : ProcessesPII(h) → ConsentChecked(h)',
      smt: `(declare-const statutory_requires_consent Bool)
(declare-const handler_checks_consent Bool)
(assert (! (= statutory_requires_consent ${b.requireConsentCheck}) :named law_gdpr_art6_lawful_basis))
(assert (! (=> statutory_requires_consent handler_checks_consent) :named inv_consent_checked))`,
      params: { requireConsentCheck: b.requireConsentCheck },
    },
    BREACH_NOTIFICATION: {
      modality: 'OBLIGATION', op: 'O(φ)', actor: 'Data Controller / Incident Response',
      action: `Notify the supervisory authority of a personal-data breach within ${b.maxBreachNotificationHours} hours (GDPR Art. 33)`,
      scope: ['breach_notification_policy'], condition: `Configured(BreachDeadline) ∧ BreachDeadline ≤ ${b.maxBreachNotificationHours}h`,
      formula: `O(Notify(SA) within ${b.maxBreachNotificationHours}h)`, fol: '∃p ∈ Policies : BreachDeadline(p) ∧ ∀p : Hours(p) ≤ Max',
      smt: `(declare-const law_max_breach_notification_minutes Int)
(declare-const configured_breach_notification_minutes Int)
(assert (! (= law_max_breach_notification_minutes ${Math.round(b.maxBreachNotificationHours * 60)}) :named law_gdpr_art33_deadline))
(assert (! (<= configured_breach_notification_minutes law_max_breach_notification_minutes) :named inv_breach_deadline_within_limit))`,
      params: { maxBreachNotificationHours: b.maxBreachNotificationHours },
    },
    DPIA_REQUIRED: {
      modality: 'OBLIGATION', op: 'O(φ)', actor: 'Data Controller / High-Risk Processing',
      action: 'Carry out a data protection impact assessment before high-risk processing (GDPR Art. 35)',
      scope: ['ai_decision_nodes', 'dpia_records'], condition: '∀ n ∈ HighRiskNodes : ∃ d ∈ DPIARecords : Exists(d)',
      formula: 'O(HighRisk(n) → DPIA)', fol: '∀n : HighRisk(n) → ∃d : DPIA(d) ∧ OnRecord(d)',
      smt: `(declare-const statutory_requires_dpia Bool)
(declare-const dpia_on_record Bool)
(assert (! (= statutory_requires_dpia ${b.requireDpia}) :named law_gdpr_art35_dpia))
(assert (! (=> statutory_requires_dpia dpia_on_record) :named inv_dpia_on_record))`,
      params: { requireDpia: b.requireDpia },
    },
    DATA_MINIMISATION: {
      modality: 'PROHIBITION', op: 'F(φ)', actor: 'Data Controller / Intake Models',
      action: 'Collect only personal data that is used (GDPR Art. 5(1)(c))',
      scope: ['pii_collection_models'], condition: '∀ m ∈ Models : UnusedPIIFields(m) = ∅',
      formula: 'F(∃m, f : Collects(m, f) ∧ ¬Used(f))', fol: '∀m ∀f : Collects(m, f) ∧ PII(f) → Used(f)',
      smt: `(declare-const statutory_forbids_unused_pii Bool)
(declare-const model_unused_pii_fields Int)
(assert (! (= statutory_forbids_unused_pii ${b.forbidUnusedPiiFields}) :named law_gdpr_art5_1c_minimisation))
(assert (! (=> statutory_forbids_unused_pii (= model_unused_pii_fields 0)) :named inv_no_unused_pii_fields))`,
      params: { forbidUnusedPiiFields: b.forbidUnusedPiiFields },
    },
    PURPOSE_LIMITATION: {
      modality: 'OBLIGATION', op: 'O(φ)', actor: 'Data Controller / Request Handlers',
      action: `Process personal data only for declared, permitted purposes${b.allowedProcessingPurposes.length ? ` (${b.allowedProcessingPurposes.join(', ')})` : ''} (GDPR Art. 5(1)(b))`,
      scope: ['pii_entrypoints'], condition: `∀ h ∈ PIIEntryPoints : Purpose(h) ∈ {${b.allowedProcessingPurposes.join(', ') || 'declared'}}`,
      formula: 'O(∀h : Purpose(h) ∈ Permitted)', fol: '∀h : ProcessesPII(h) → Declared(Purpose(h)) ∧ Permitted(Purpose(h))',
      smt: `(declare-const handler_declares_purpose Bool)
(declare-const handler_purpose_permitted Bool)
(assert (! (= handler_declares_purpose true) :named inv_purpose_declared))
(assert (! (=> handler_declares_purpose handler_purpose_permitted) :named inv_purpose_permitted))`,
      params: { allowedProcessingPurposes: b.allowedProcessingPurposes },
    },
  };
  const g = spec[category];
  if (!g) return null;
  return {
    deontic: {
      modality: g.modality,
      deonticOperatorSymbol: g.op,
      actor: g.actor,
      regulatedAction: g.action,
      targetDataScope: g.scope,
      normativeCondition: g.condition,
      formalPredicateSummary: g.formula,
      extractedParameters: g.params,
      extractionProvenance: b.provenance,
    },
    compiled: {
      deonticFormula: g.formula,
      firstOrderLogic: g.fol,
      smtLib2Snippet: `${header}\n${g.smt}`,
      opaRegoRule: regoPolicyFor(category, regoBounds(b), citation),
      astPatternQuery: treeSitterQueriesFor(category),
    },
  };
}

export function compileLegalProseToFormalPolicy(
  rawText: string,
  category: RuleCategory,
  clauseId: string,
  citation: string
): { deontic: DeonticExtraction; compiled: CompiledPolicyArtifacts } {
  return compileFromBounds(
    extractDeonticBoundsFromProse(rawText, category),
    category,
    clauseId,
    citation
  );
}

export async function compileLegalProseToFormalPolicyAsync(
  rawText: string,
  category: RuleCategory,
  clauseId: string,
  citation: string
): Promise<{ deontic: DeonticExtraction; compiled: CompiledPolicyArtifacts }> {
  const bounds = await extractDeonticBoundsWithLlmFallback(rawText, category);
  return compileFromBounds(bounds, category, clauseId, citation);
}

/**
 * Default Baseline Statutory & Contractual Clauses
 * Note: Notice how CLAUSE-DPA-4.2 starts at the baseline "30 days (720 hours) with standard AES-256 encryption",
 * OR can be mutated in 1 click to "encrypted at rest with tenant-isolated keys and purged within 72 hours"!
 * Wait: Let's make sure on initial load we already have a rich mix of BOTH:
 * - Active live violations in the repo AND the flagship clause ready to either inspect or mutate!
 * Even better: let's have CLAUSE-DPA-4.2 already compiled with the active regulatory text, and provide
 * both a "Reset to Legacy 30-Day Baseline (Compliant)" and "Simulate Regulatory Amendment (72h + Tenant KMS)"!
 */
export function getInitialClauses(): LegalClause[] {
  const rawDpaText =
    'Section 4.2 (Data Retention & Cryptographic Isolation — GDPR Art. 17 & Art. 32 / CCPA §1798.105): All Personal Identifiable Information (PII) and Protected Health Information (PHI) ingested via API endpoints, cached in memory workers, or persisted in relational tables must be encrypted at rest with tenant-isolated keys (per-tenant KMS envelope) and purged within 72 hours across all storage tiers.';
  const dpaCompiled = compileLegalProseToFormalPolicy(
    rawDpaText,
    'RETENTION_AND_TENANT_KMS',
    'CLAUSE-DPA-4.2',
    'GDPR Art. 17 & 32 / DPA §4.2'
  );

  const rawHipaaLogText =
    'HIPAA §164.312(b) & GDPR Art. 5(1)(f) (Integrity & Confidentiality — Zero Plaintext PII in Telemetry): Application endpoints and background workers are strictly prohibited from logging unredacted PII or PHI (including SSN, patient email, or clinical diagnosis codes) into application stdout or observability log sinks.';
  const hipaaCompiled = compileLegalProseToFormalPolicy(
    rawHipaaLogText,
    'PII_LOGGING_BAN',
    'CLAUSE-HIPAA-312B',
    'HIPAA §164.312(b) / GDPR Art. 5(1)(f)'
  );

  const rawEuAiActText =
    'EU AI Act Article 14 & Article 12 (Human Oversight & Record-Keeping for High-Risk AI Systems): High-risk AI credit and clinical triage models shall not execute autonomous rejections or approvals when model confidence score falls below 0.85 (85%), and must enforce a mandatory Human-in-the-Loop escalation gate with immutable audit logging.';
  const euAiCompiled = compileLegalProseToFormalPolicy(
    rawEuAiActText,
    'AI_HUMAN_IN_THE_LOOP',
    'CLAUSE-EU-AI-14',
    'EU AI Act Art. 14 & Art. 12'
  );

  const rawCrossBorderText =
    'GDPR Chapter V — Article 44 (General Principle for Transfers & Sovereign EU Residency): Personal data undergoing processing shall not be replicated or transferred to third-country cloud regions outside approved EEA sovereign zones (eu-central-1, eu-west-1); transfer to us-east-1 is strictly prohibited.';
  const crossBorderCompiled = compileLegalProseToFormalPolicy(
    rawCrossBorderText,
    'CROSS_BORDER_TRANSFER',
    'CLAUSE-GDPR-44',
    'GDPR Art. 44 (Chapter V)'
  );

  return [
    {
      id: 'CLAUSE-DPA-4.2',
      frameworkId: 'ENTERPRISE_DPA',
      frameworkName: 'GDPR Art. 17 / Enterprise DPA',
      citation: 'GDPR Art. 17 & 32 / DPA §4.2',
      title: 'Tenant-Isolated KMS Encryption & 72-Hour PII Purge Mandate',
      severity: 'CRITICAL',
      category: 'RETENTION_AND_TENANT_KMS',
      rawLegalText: rawDpaText,
      version: 'v2026.4-AMENDED',
      lastAmended: '2026-10-28',
      sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
      illustrative: true,
      deontic: dpaCompiled.deontic,
      compiled: dpaCompiled.compiled,
    },
    {
      id: 'CLAUSE-HIPAA-312B',
      frameworkId: 'HIPAA',
      frameworkName: 'HIPAA Security Rule',
      citation: 'HIPAA §164.312(b) / GDPR Art. 5(1)(f)',
      title: 'Prohibition on Unredacted PII/PHI in Application Logs',
      severity: 'HIGH',
      category: 'PII_LOGGING_BAN',
      rawLegalText: rawHipaaLogText,
      version: '45 CFR §164.312',
      lastAmended: '2026-09-15',
      sourceUrl: 'https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312',
      illustrative: true,
      deontic: hipaaCompiled.deontic,
      compiled: hipaaCompiled.compiled,
    },
    {
      id: 'CLAUSE-EU-AI-14',
      frameworkId: 'EU_AI_ACT',
      frameworkName: 'EU Artificial Intelligence Act',
      citation: 'EU AI Act Art. 14 & Art. 12',
      title: 'High-Risk AI Human-in-the-Loop Gate (≥85% Confidence) & Audit Trail',
      severity: 'CRITICAL',
      category: 'AI_HUMAN_IN_THE_LOOP',
      rawLegalText: rawEuAiActText,
      version: 'Regulation (EU) 2024/1689',
      lastAmended: '2026-08-02',
      sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      illustrative: true,
      deontic: euAiCompiled.deontic,
      compiled: euAiCompiled.compiled,
    },
    {
      id: 'CLAUSE-GDPR-44',
      frameworkId: 'GDPR',
      frameworkName: 'EU General Data Protection Regulation',
      citation: 'GDPR Art. 44 (Chapter V)',
      title: 'Cross-Border Data Residency & Third-Country Transfer Prohibition',
      severity: 'HIGH',
      category: 'CROSS_BORDER_TRANSFER',
      rawLegalText: rawCrossBorderText,
      version: 'Regulation (EU) 2016/679',
      lastAmended: '2026-07-19',
      sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
      illustrative: true,
      deontic: crossBorderCompiled.deontic,
      compiled: crossBorderCompiled.compiled,
    },
  ];
}

export function getBanglaInitialClauses(): LegalClause[] {
  const rawBdBankDpa =
    'ধারা ৪.২ (বাংলাদেশ ব্যাংক আইসিটি নিরাপত্তা নীতিমালা ৪.০ ও উপাত্ত সুরক্ষা আইন): গ্রাহকের সকল ব্যক্তিগত ও আর্থিক সংবেদনশীল তথ্য (PII/PHI) অবশ্যই টেন্যান্ট আইসোলেটেড কেএমএস কী দ্বারা এনক্রিপ্টেড থাকতে হবে এবং ৪৮ ঘণ্টার মধ্যে ডাটাবেস ও ক্যাশ মেমোরি থেকে সম্পূর্ণরূপে মুছে ফেলতে হবে।';
  const bdDpaCompiled = compileLegalProseToFormalPolicy(
    rawBdBankDpa,
    'RETENTION_AND_TENANT_KMS',
    'CLAUSE-DPA-4.2',
    'বাংলাদেশ ব্যাংক নীতিমালা ধারা ৪.২ / GDPR Art. 17'
  );

  const rawBdLogBan =
    'ধারা ২৬ (সাইবার নিরাপত্তা ও ডিজিটাল স্বাস্থ্য উপাত্ত গোপনীয়তা বিধিমালা): অ্যাপ্লিকেশন এন্ডপয়েন্ট বা সার্ভার লগে গ্রাহকের জাতীয় পরিচয়পত্র, এসএসএন, ইমেইল কিংবা চিকিৎসা সংক্রান্ত তথ্য অরক্ষিত অবস্থায় লগিং সম্পূর্ণ নিষিদ্ধ এবং প্রকাশ করা যাবে না; লগে লেখার পূর্বে অবশ্যই ক্রিপ্টোগ্রাফিক হ্যাশ দ্বারা রিড্যাক্ট করতে হবে।';
  const bdLogCompiled = compileLegalProseToFormalPolicy(
    rawBdLogBan,
    'PII_LOGGING_BAN',
    'CLAUSE-HIPAA-312B',
    'সাইবার নিরাপত্তা বিধিমালা ধারা ২৬ / HIPAA §164.312(b)'
  );

  const rawBdAiAct =
    'অনুচ্ছেদ ১৪ (উচ্চ-ঝুঁকিপূর্ণ কৃত্রিম বুদ্ধিমত্তা ও ঋণ ঝুঁকি মূল্যায়ন নীতিমালা): এআই মডেলের আত্মবিশ্বাস স্কোর কমপক্ষে ৮৫% (০.৮৫)-এর নিচে হলে কোনো স্বয়ংক্রিয় সিদ্ধান্ত কার্যকর করা যাবে না; এক্ষেত্রে বাধ্যতামূলক মানব তদারকি (হিউম্যান গেট) এবং অপরিবর্তনীয় অডিট লগ নিশ্চিত করতে হবে।';
  const bdAiCompiled = compileLegalProseToFormalPolicy(
    rawBdAiAct,
    'AI_HUMAN_IN_THE_LOOP',
    'CLAUSE-EU-AI-14',
    'এআই তদারকি নীতিমালা অনুচ্ছেদ ১৪ / EU AI Act Art. 14'
  );

  const rawBdResidency =
    'অধ্যায় ৫ — ধারা ৪৪ (সার্বভৌম ডাটা রেসিডেন্সি ও আন্তঃসীমান্ত স্থানান্তর নিষেধাজ্ঞা): গ্রাহকের সংবেদনশীল ব্যক্তিগত উপাত্ত অনুমোদিত সার্বভৌম অঞ্চলের বাইরে (যেমন অনুমোদনহীন তৃতীয় দেশের ক্লাউড রিজিয়নে) রেপ্লিকেশন বা দেশের বাইরে স্থানান্তর নিষিদ্ধ।';
  const bdResidencyCompiled = compileLegalProseToFormalPolicy(
    rawBdResidency,
    'CROSS_BORDER_TRANSFER',
    'CLAUSE-GDPR-44',
    'সার্বভৌম ডাটা রেসিডেন্সি ধারা ৪৪ / GDPR Art. 44'
  );

  return [
    {
      id: 'CLAUSE-DPA-4.2',
      frameworkId: 'ENTERPRISE_DPA',
      frameworkName: 'বাংলাদেশ ব্যাংক আইসিটি নীতিমালা / DPA',
      citation: 'বাংলাদেশ ব্যাংক ধারা ৪.২ / DPA §4.2',
      title: 'টেন্যান্ট-আইসোলেটেড KMS এনক্রিপশন ও ৪৮ ঘণ্টা উপাত্ত অপসারণ বাধ্যবাধকতা',
      severity: 'CRITICAL',
      category: 'RETENTION_AND_TENANT_KMS',
      rawLegalText: rawBdBankDpa,
      version: 'BD-ICT-v4.0-বাংলা',
      lastAmended: '2026-10-28',
      sourceUrl: 'https://www.bb.org.bd/',
      illustrative: true,
      deontic: bdDpaCompiled.deontic,
      compiled: bdDpaCompiled.compiled,
    },
    {
      id: 'CLAUSE-HIPAA-312B',
      frameworkId: 'HIPAA',
      frameworkName: 'সাইবার নিরাপত্তা ও স্বাস্থ্য উপাত্ত বিধিমালা',
      citation: 'সাইবার নিরাপত্তা ধারা ২৬ / HIPAA §164.312(b)',
      title: 'অ্যাপ্লিকেশন লগে অরক্ষিত ব্যক্তিগত তথ্য (PII/PHI) সংরক্ষণ নিষেধাজ্ঞা',
      severity: 'HIGH',
      category: 'PII_LOGGING_BAN',
      rawLegalText: rawBdLogBan,
      version: 'BD-CSA-2026-বাংলা',
      lastAmended: '2026-09-15',
      sourceUrl: 'https://www.cirt.gov.bd/',
      illustrative: true,
      deontic: bdLogCompiled.deontic,
      compiled: bdLogCompiled.compiled,
    },
    {
      id: 'CLAUSE-EU-AI-14',
      frameworkId: 'EU_AI_ACT',
      frameworkName: 'উচ্চ-ঝুঁকিপূর্ণ এআই তদারকি নীতিমালা',
      citation: 'এআই নীতিমালা অনুচ্ছেদ ১৪ / EU AI Act Art. 14',
      title: 'উচ্চ-ঝুঁকিপূর্ণ এআই মানব তদারকি গেট (≥৮৫% আত্মবিশ্বাস) ও অডিট ট্রেইল',
      severity: 'CRITICAL',
      category: 'AI_HUMAN_IN_THE_LOOP',
      rawLegalText: rawBdAiAct,
      version: 'AI-GOV-2026-বাংলা',
      lastAmended: '2026-08-02',
      sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      illustrative: true,
      deontic: bdAiCompiled.deontic,
      compiled: bdAiCompiled.compiled,
    },
    {
      id: 'CLAUSE-GDPR-44',
      frameworkId: 'GDPR',
      frameworkName: 'সার্বভৌম ডাটা রেসিডেন্সি বিধিমালা',
      citation: 'ডাটা রেসিডেন্সি ধারা ৪৪ / GDPR Art. 44',
      title: 'সার্বভৌম ডাটা রেসিডেন্সি ও অননুমোদিত আন্তঃসীমান্ত স্থানান্তর নিষেধাজ্ঞা',
      severity: 'HIGH',
      category: 'CROSS_BORDER_TRANSFER',
      rawLegalText: rawBdResidency,
      version: 'BD-DPA-2026-বাংলা',
      lastAmended: '2026-07-19',
      sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
      illustrative: true,
      deontic: bdResidencyCompiled.deontic,
      compiled: bdResidencyCompiled.compiled,
    },
  ];
}

export function getMutationPresets(): RegulatoryMutationPreset[] {
  return [
    {
      id: 'PRESET-72H-TENANT-KMS',
      name: 'Amend DPA §4.2 / GDPR Art. 17: 30 Days → 72 Hours + Tenant-Isolated KMS Keys',
      badge: 'FLAGSHIP DEMO SHOCKWAVE',
      frameworkId: 'ENTERPRISE_DPA',
      clauseId: 'CLAUSE-DPA-4.2',
      description:
        'Mutates the retention clause from "purged within 30 days" to "encrypted at rest with tenant-isolated keys and purged within 72 hours", sending a shockwave that turns Postgres Schema, FastAPI Endpoint, and Redis Worker crimson.',
      previousLawExcerpt:
        'PII must be encrypted at rest using standard AES-256 encryption and purged within 30 days (720 hours).',
      mutatedLawText:
        'Section 4.2 (Data Retention & Cryptographic Isolation — GDPR Art. 17 & Art. 32 / CCPA §1798.105): All Personal Identifiable Information (PII) and Protected Health Information (PHI) ingested via API endpoints, cached in memory workers, or persisted in relational tables must be encrypted at rest with tenant-isolated keys (per-tenant KMS envelope) and purged within 72 hours across all storage tiers.',
      parameterDiffSummary: 'max_ttl_hours: 720h → 72h | requires_tenant_kms: false → true',
      blastRadiusNodeIds: ['node-postgres-schema', 'node-fastapi-endpoint', 'node-redis-worker'],
    },
    {
      id: 'PRESET-LEGACY-30D-BASELINE',
      name: 'Restore Legacy Contract Baseline (30-Day Retention / No Tenant KMS)',
      badge: 'BASELINE REGIME',
      frameworkId: 'ENTERPRISE_DPA',
      clauseId: 'CLAUSE-DPA-4.2',
      description:
        'Reverts Section 4.2 back to the legacy 30-day (720 hours) retention window without tenant-isolated KMS key requirements so you can observe the live before/after shockwave transition.',
      previousLawExcerpt:
        'PII must be encrypted at rest with tenant-isolated keys and purged within 72 hours.',
      mutatedLawText:
        'Section 4.2 (Legacy Data Retention Baseline): All Personal Identifiable Information (PII) persisted in relational tables or cache workers must be encrypted at rest and purged within 30 days (720 hours) of session termination.',
      parameterDiffSummary: 'max_ttl_hours: 72h → 720h | requires_tenant_kms: true → false',
      blastRadiusNodeIds: ['node-postgres-schema', 'node-fastapi-endpoint', 'node-redis-worker'],
    },
    {
      id: 'PRESET-EU-AI-ACT-92PCT',
      name: 'EU AI Act Art. 14 Emergency Tightening: Raise Confidence Threshold to 92%',
      badge: 'EU AI ACT AMENDMENT',
      frameworkId: 'EU_AI_ACT',
      clauseId: 'CLAUSE-EU-AI-14',
      description:
        'Tightens EU AI Act Article 14 human oversight threshold from 85% to 92% (0.92) minimum model confidence for automated clinical & credit triage.',
      previousLawExcerpt:
        'High-risk AI models shall not execute autonomous decisions when confidence falls below 0.85 (85%).',
      mutatedLawText:
        'EU AI Act Article 14 (Amended High-Risk Threshold): High-risk AI credit and clinical triage models shall not execute autonomous rejections or approvals when model confidence score falls below 0.92 (92%), and must enforce a mandatory Human-in-the-Loop escalation gate with immutable audit logging.',
      parameterDiffSummary: 'statutory_min_confidence_pct: 85% → 92%',
      blastRadiusNodeIds: ['node-ai-engine'],
    },
    {
      id: 'PRESET-24H-ULTRA-STRICT',
      name: 'Zero-Retention HIPAA/GDPR Emergency Mandate: 24-Hour Purge Window',
      badge: '24H ULTRA-STRICT',
      frameworkId: 'ENTERPRISE_DPA',
      clauseId: 'CLAUSE-DPA-4.2',
      description:
        'Tightens ephemeral PII retention window even further to 24 hours with mandatory tenant-isolated KMS envelopes.',
      previousLawExcerpt:
        'PII must be encrypted at rest with tenant-isolated keys and purged within 72 hours.',
      mutatedLawText:
        'Section 4.2 (Ultra-Strict Ephemeral Mandate): All Personal Identifiable Information (PII) and PHI must be encrypted at rest with tenant-isolated keys (per-tenant KMS envelope) and purged within 24 hours across all storage tiers and Redis caches.',
      parameterDiffSummary: 'max_ttl_hours: 72h → 24h | requires_tenant_kms: true',
      blastRadiusNodeIds: ['node-postgres-schema', 'node-fastapi-endpoint', 'node-redis-worker'],
    },
    {
      id: 'PRESET-BANGLADESH-BANK-48H',
      name: 'Bangladesh Bank ICT Guideline v4.0 (বাংলাদেশ ব্যাংক নীতিমালা): ৪৮ ঘণ্টা রিটেনশন ও টেন্যান্ট KMS',
      badge: 'BANGLA / BD FINTECH',
      frameworkId: 'ENTERPRISE_DPA',
      clauseId: 'CLAUSE-DPA-4.2',
      description:
        'Compiles bilingual Bangla + English regulatory prose from Bangladesh Bank ICT Security Guideline & Cyber Security Act (৪৮ ঘণ্টা / 48 hours purge + টেন্যান্ট KMS key isolation) directly into Z3 SMT-LIB2.',
      previousLawExcerpt:
        'PII must be purged within 72 hours.',
      mutatedLawText:
        'ধারা ৪.২ (বাংলাদেশ ব্যাংক আইসিটি নিরাপত্তা নীতিমালা ও সাইবার নিরাপত্তা আইন / Bangladesh Bank ICT Guideline §4.2): গ্রাহকের সকল ব্যক্তিগত ও আর্থিক তথ্য (PII/PHI) অবশ্যই টেন্যান্ট-আইসোলেটেড KMS কী (tenant-isolated keys) দ্বারা এনক্রিপ্টেড থাকতে হবে এবং ৪৮ ঘণ্টা (48 hours)-এর মধ্যে ডাটাবেস ও ক্যাশ থেকে সম্পূর্ণরূপে মুছে ফেলতে হবে।',
      parameterDiffSummary: 'lang: বাংলা+EN | max_ttl_hours: 48h (৪৮ ঘণ্টা) | tenant_kms: true',
      blastRadiusNodeIds: ['node-postgres-schema', 'node-fastapi-endpoint', 'node-redis-worker'],
    },
  ];
}

/**
 * Fetches live regulatory updates from the official US Federal Register API
 * plus curated EUR-Lex Official Journal statutes.
 */
const TRACKED_ARTICLES: Record<string, { celex: string; article: number }> = {
  'EURLEX-32024R1689-ART14': { celex: '32024R1689', article: 14 },
  'EURLEX-32016R0679-ART17': { celex: '32016R0679', article: 17 },
};

/**
 * Replaces curated excerpts with the official article text from EUR-Lex and adds the acts
 * CELLAR lists as amending or correcting the tracked regulations. Unreachable sources leave
 * the curated (illustrative) items in place.
 */
async function withOfficialEurLexText(items: LiveRegulatoryFeedItem[], fetchImpl: typeof fetch): Promise<LiveRegulatoryFeedItem[]> {
  const official = await Promise.all(
    items.map(async (item) => {
      const tracked = TRACKED_ARTICLES[item.id];
      if (!tracked) return item;
      const art = await fetchEurLexArticle(tracked.celex, tracked.article, fetchImpl).catch(() => null);
      return art
        ? { ...item, title: `${item.documentNumber} — ${art.title}`, agencyOrBody: 'EUR-Lex (official text)', excerpt: art.text.slice(0, 1200), url: art.url, illustrative: false }
        : item;
    })
  );
  const amendments = await fetchEurLexAmendments(['32016R0679', '32024R1689'], fetchImpl).catch(() => []);
  return [
    ...official,
    ...amendments.map((a): LiveRegulatoryFeedItem => ({
      id: `EURLEX-${a.relation.toUpperCase()}-${a.celex}`,
      source: 'EUR_LEX',
      documentNumber: `CELEX:${a.celex}`,
      title: `CELEX:${a.celex} ${a.relation} CELEX:${a.targetCelex}`,
      publicationDate: a.date || '',
      agencyOrBody: 'Publications Office of the EU (CELLAR SPARQL)',
      excerpt: `Act ${a.celex} ${a.relation} ${a.targetCelex}; review the clauses compiled from ${a.targetCelex}.`,
      url: a.url,
      suggestedFramework: a.targetCelex === '32024R1689' ? 'EU_AI_ACT' : 'GDPR',
      kind: 'CHANGE_NOTICE',
    })),
  ];
}

export async function fetchLiveRegulatoryFeed(fetchImpl: typeof fetch = fetch): Promise<LiveRegulatoryFeedItem[]> {
  const curated: LiveRegulatoryFeedItem[] = [
    {
      id: 'EURLEX-32024R1689-ART14',
      source: 'EUR_LEX',
      documentNumber: 'CELEX:32024R1689',
      title: '[Illustrative] Regulation (EU) 2024/1689 (EU AI Act) — Art. 14 Human Oversight & Art. 12 Record-Keeping',
      publicationDate: '2024-07-12',
      agencyOrBody: 'European Parliament & Council of the European Union (excerpt + LexCompiler demo parameter)',
      excerpt:
        'High-risk AI systems shall be designed and developed in such a way, including with appropriate human-machine interface tools, that they can be effectively overseen by natural persons during the period in which they are in use. [Illustrative demo parameter — not in Regulation (EU) 2024/1689: minimum confidence gate 0.88 (88%) for automated clinical/credit decisions.]',
      illustrative: true,
      url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      suggestedFramework: 'EU_AI_ACT',
    },
    {
      id: 'EURLEX-32016R0679-ART17',
      source: 'EUR_LEX',
      documentNumber: 'CELEX:32016R0679',
      title: '[Illustrative] Demo DPA obligation referencing GDPR Art. 17 (Erasure) & Art. 32 (Security of Processing)',
      publicationDate: '2026-05-25',
      agencyOrBody: 'LexCompiler demo scenario — not EDPB or EUR-Lex text',
      excerpt:
        '[Illustrative demo obligation — GDPR itself sets no such retention period:] Personal identifiable information (PII) must be encrypted at rest with tenant-isolated keys and purged within 72 hours of session or retention expiration across relational databases and memory caches.',
      illustrative: true,
      url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
      suggestedFramework: 'ENTERPRISE_DPA',
    },
  ];

  const curatedEurLex = await withOfficialEurLexText(curated, fetchImpl);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const url =
      'https://www.federalregister.gov/api/v1/documents.json?per_page=3&order=newest&conditions%5Bterm%5D=privacy+cybersecurity+encryption';
    const resp = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (resp.ok) {
      const data = (await resp.json()) as {
        results?: Array<{
          document_number?: string;
          title?: string;
          publication_date?: string;
          abstract?: string;
          html_url?: string;
          agencies?: Array<{ name?: string }>;
        }>;
      };
      const liveFedItems: LiveRegulatoryFeedItem[] = (data.results || []).map((doc, idx) => ({
        id: `FEDREG-${doc.document_number || idx}`,
        source: 'FEDERAL_REGISTER',
        documentNumber: doc.document_number || 'FR-2026',
        title: doc.title || 'Federal Register Cybersecurity & Privacy Rulemaking',
        publicationDate: doc.publication_date || '2026-10-01',
        agencyOrBody: doc.agencies?.[0]?.name || 'U.S. Federal Register',
        excerpt: doc.abstract || '(No abstract was published for this Federal Register document.)',
        url: doc.html_url || 'https://www.federalregister.gov',
        suggestedFramework: 'HIPAA',
      }));
      return [...curatedEurLex, ...liveFedItems];
    }
  } catch {
    // Fallback cleanly if offline or firewall blocks outbound fetch
  }

  return [
    ...curatedEurLex,
    {
      id: 'ILLUSTRATIVE-HIPAA-OFFLINE',
      source: 'FEDERAL_REGISTER',
      documentNumber: 'ILLUSTRATIVE (offline fallback)',
      title: '[Illustrative] HIPAA-style encryption & cache-purge scenario — not a Federal Register document',
      publicationDate: '2026-09-18',
      agencyOrBody: 'LexCompiler demo data (shown because the Federal Register API was unreachable)',
      excerpt:
        '[Illustrative demo obligation:] Covered entities and business associates must encrypt all ePHI at rest with tenant-isolated keys, purge ephemeral cache workers within 72 hours, and strictly prohibit unredacted PHI in application log sinks.',
      illustrative: true,
      url: 'https://www.federalregister.gov/',
      suggestedFramework: 'HIPAA',
    },
  ];
}
