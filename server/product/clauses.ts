import {
  FRAMEWORK_DISPLAY_NAMES,
  compileLegalProseToFormalPolicy,
  compileLegalProseWithOverrides,
  getInitialClauses,
  inferRuleCategoryFromProse,
  type RuleValueOverrides,
} from '../compiler/legalCompiler.js';
import type { ComplianceFrameworkId, LegalClause, RuleCategory } from '../../shared/types.js';

/**
 * Values Legal set or confirmed on the rule card; they replace what the parser read. One type for
 * both rule-card screens: the compiler's `RuleValueOverrides`.
 */
export type ClauseValues = RuleValueOverrides;

export interface ClauseInput {
  text: string;
  key: string;
  title?: string;
  citation?: string;
  category?: RuleCategory;
  frameworkId?: ComplianceFrameworkId;
  values?: ClauseValues;
}

const HOURS_MIN = 1 / 60;
const HOURS_MAX = 24 * 365 * 100;
const REGION_RE = /^[a-z0-9-]{2,30}$/;
const MAX_REGIONS = 20;

/**
 * Checks Legal's values: hours between 1 minute and 100 years, a confidence above 0 and at most 1,
 * a yes/no for tenant-isolated keys, and region ids such as eu-central-1 (at most 20). Numeric
 * strings and "true"/"false" are accepted; blank values are skipped.
 *
 * Strict by default: a bad value or an unknown key throws (the API answers 400). With
 * `lenient`, bad values, bad region ids and unknown keys are dropped instead (the rule-card
 * preview, see `cleanOverrides`).
 */
export function validateClauseValues(values: unknown, opts: { lenient?: boolean } = {}): ClauseValues {
  const lenient = opts.lenient === true;
  if (values === undefined || values === null) return {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    if (lenient) return {};
    throw new Error('values must be an object');
  }
  const out: ClauseValues = {};
  const fail = (message: string) => {
    if (!lenient) throw new Error(message);
  };
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    if (v === null || v === undefined || v === '') continue;
    if (k === 'maxRetentionHours' || k === 'maxBreachNotificationHours') {
      const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n) || n < HOURS_MIN || n > HOURS_MAX) fail(`${k} must be between 1 minute and 100 years, in hours`);
      else out[k] = Math.round(n * 1000) / 1000;
    } else if (k === 'minAiConfidenceThreshold') {
      const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n) || n <= 0 || n > 1) fail('minAiConfidenceThreshold must be above 0 and at most 1');
      else out[k] = n;
    } else if (k === 'requiresTenantIsolatedKeys') {
      if (typeof v === 'boolean') out[k] = v;
      else if (v === 'true' || v === 'false') out[k] = v === 'true';
      else fail('requiresTenantIsolatedKeys must be true or false');
    } else if (k === 'allowedDataRegions') {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
      if (!list) {
        fail('allowedDataRegions must be a list of region ids, for example ["eu-central-1"]');
        continue;
      }
      const regions: string[] = [];
      for (const raw of list) {
        const r = String(raw).trim().toLowerCase();
        if (!r) continue;
        if (REGION_RE.test(r)) regions.push(r);
        else fail(`allowedDataRegions: "${String(raw).slice(0, 40)}" is not a region id (letters, digits and dashes, for example eu-central-1)`);
      }
      const unique = [...new Set(regions)];
      if (unique.length > MAX_REGIONS) fail(`allowedDataRegions takes at most ${MAX_REGIONS} regions`);
      if (unique.length) out[k] = unique.slice(0, MAX_REGIONS);
    } else {
      fail(`unknown value ${k}`);
    }
  }
  return out;
}

function assemble(input: ClauseInput, category: RuleCategory, compiled: Pick<LegalClause, 'deontic' | 'compiled'>): LegalClause {
  const framework: ComplianceFrameworkId =
    input.frameworkId && Object.hasOwn(FRAMEWORK_DISPLAY_NAMES, input.frameworkId) ? input.frameworkId : 'ENTERPRISE_DPA';
  return {
    id: input.key,
    frameworkId: framework,
    frameworkName: FRAMEWORK_DISPLAY_NAMES[framework],
    citation: input.citation?.trim() || input.key,
    title: input.title?.trim() || input.citation?.trim() || input.key,
    severity: 'HIGH',
    category,
    rawLegalText: input.text.trim(),
    version: '1',
    lastAmended: new Date().toISOString().slice(0, 10),
    illustrative: false,
    ...compiled,
  };
}

/** Every rule category. The Record type makes the compiler flag a category added to RuleCategory but not here. */
const CATEGORY_SET: Record<RuleCategory, true> = {
  RETENTION_AND_TENANT_KMS: true,
  ENCRYPTION_AT_REST: true,
  PII_LOGGING_BAN: true,
  RIGHT_TO_ERASURE_CASCADE: true,
  AI_HUMAN_IN_THE_LOOP: true,
  CROSS_BORDER_TRANSFER: true,
  CONSENT_LAWFUL_BASIS: true,
  BREACH_NOTIFICATION: true,
  DPIA_REQUIRED: true,
  DATA_MINIMISATION: true,
  PURPOSE_LIMITATION: true,
};
export const RULE_CATEGORIES = Object.keys(CATEGORY_SET) as RuleCategory[];
export function isRuleCategory(value: unknown): value is RuleCategory {
  return typeof value === 'string' && Object.hasOwn(CATEGORY_SET, value);
}

/**
 * Compiles legal text into a rule draft with the deterministic parser only. A model never fills
 * in a workspace's rule values here: AI drafting (product guide 5.4) proposes values separately,
 * and only values the parser confirms are shown to Legal.
 */
export async function compileClause(input: ClauseInput): Promise<LegalClause> {
  return compileClauseSync(input);
}

/**
 * Deterministic compile, no LLM. Values from the rule card replace the parser's reading through
 * the compiler's one override engine (`compileLegalProseWithOverrides`, provenance 'LEGAL_REVIEW').
 */
export function compileClauseSync(input: ClauseInput): LegalClause {
  const category = input.category ?? inferRuleCategoryFromProse(input.text);
  const citation = input.citation || input.key;
  const values = input.values ?? {};
  const compiled = Object.values(values).some((v) => v !== undefined)
    ? compileLegalProseWithOverrides(input.text, category, input.key, citation, values)
    : compileLegalProseToFormalPolicy(input.text, category, input.key, citation);
  return assemble(input, category, compiled);
}

/** The built-in illustrative clauses, offered as templates in the rule library. */
export function libraryTemplates(): Array<Pick<LegalClause, 'id' | 'title' | 'citation' | 'category' | 'frameworkId' | 'rawLegalText'>> {
  return getInitialClauses().map((c) => ({ id: c.id, title: c.title, citation: c.citation, category: c.category, frameworkId: c.frameworkId, rawLegalText: c.rawLegalText }));
}
