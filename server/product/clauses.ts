import {
  FRAMEWORK_DISPLAY_NAMES,
  compileFromBounds,
  extractDeonticBoundsFromProse,
  getInitialClauses,
  inferRuleCategoryFromProse,
} from '../compiler/legalCompiler.js';
import type { ComplianceFrameworkId, LegalClause, RuleCategory } from '../../shared/types.js';

/** Numbers Legal set or confirmed on the rule card; they replace what the parser read. */
export interface ClauseValues {
  maxRetentionHours?: number;
  maxBreachNotificationHours?: number;
  minAiConfidenceThreshold?: number;
}

export interface ClauseInput {
  text: string;
  key: string;
  title?: string;
  citation?: string;
  category?: RuleCategory;
  frameworkId?: ComplianceFrameworkId;
  values?: ClauseValues;
}

/** Checks Legal's values: hours between 1 minute and 100 years, confidence between 0 and 1. */
export function validateClauseValues(values: unknown): ClauseValues {
  if (values === undefined || values === null) return {};
  if (typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be an object');
  const out: ClauseValues = {};
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (k === 'maxRetentionHours' || k === 'maxBreachNotificationHours') {
      if (!Number.isFinite(n) || n < 1 / 60 || n > 24 * 365 * 100) throw new Error(`${k} must be between 1 minute and 100 years, in hours`);
      out[k] = Math.round(n * 1000) / 1000;
    } else if (k === 'minAiConfidenceThreshold') {
      if (!Number.isFinite(n) || n <= 0 || n >= 1) throw new Error('minAiConfidenceThreshold must be between 0 and 1');
      out[k] = n;
    } else {
      throw new Error(`unknown value ${k}`);
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

/** Deterministic compile, no LLM. Values from the rule card replace the parser's reading. */
export function compileClauseSync(input: ClauseInput): LegalClause {
  const category = input.category ?? inferRuleCategoryFromProse(input.text);
  const bounds = extractDeonticBoundsFromProse(input.text, category);
  const v = input.values ?? {};
  const set: string[] = [];
  if (v.maxRetentionHours !== undefined) {
    bounds.maxRetentionHours = v.maxRetentionHours;
    bounds.maxRetentionDays = Math.round((v.maxRetentionHours / 24) * 1000) / 1000;
    bounds.temporalHit = true;
    set.push(`maxRetentionHours=${v.maxRetentionHours}`);
  }
  if (v.maxBreachNotificationHours !== undefined) {
    bounds.maxBreachNotificationHours = v.maxBreachNotificationHours;
    set.push(`maxBreachNotificationHours=${v.maxBreachNotificationHours}`);
  }
  if (v.minAiConfidenceThreshold !== undefined) {
    bounds.minAiConfidenceThreshold = v.minAiConfidenceThreshold;
    bounds.confidenceHit = true;
    set.push(`minAiConfidenceThreshold=${v.minAiConfidenceThreshold}`);
  }
  if (set.length > 0) {
    bounds.provenance = { ...bounds.provenance, method: 'LEGAL_REVIEW', evidence: [...bounds.provenance.evidence, ...set.map((s) => `legal:${s}`)] };
  }
  return assemble(input, category, compileFromBounds(bounds, category, input.key, input.citation || input.key));
}

/** The built-in illustrative clauses, offered as templates in the rule library. */
export function libraryTemplates(): Array<Pick<LegalClause, 'id' | 'title' | 'citation' | 'category' | 'frameworkId' | 'rawLegalText'>> {
  return getInitialClauses().map((c) => ({ id: c.id, title: c.title, citation: c.citation, category: c.category, frameworkId: c.frameworkId, rawLegalText: c.rawLegalText }));
}
