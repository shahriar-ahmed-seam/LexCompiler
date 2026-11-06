import { describe, expect, it } from 'vitest';
import {
  getBanglaInitialClauses,
  getInitialClauses,
  getMutationPresets,
  inferRuleCategoryFromProse,
  inferRuleCategoryWithEvidence,
} from './compiler/legalCompiler.js';

describe('rule category inference', () => {
  it('recovers the category of every built-in clause, in English and Bangla', () => {
    for (const c of [...getInitialClauses(), ...getBanglaInitialClauses()]) {
      expect(inferRuleCategoryFromProse(c.rawLegalText), `${c.id}: ${c.rawLegalText.slice(0, 70)}`).toBe(c.category);
    }
  });

  it('recovers the category of every amendment preset', () => {
    const categoryOf = new Map(getInitialClauses().map((c) => [c.id, c.category]));
    for (const preset of getMutationPresets()) {
      expect(inferRuleCategoryFromProse(preset.mutatedLawText), preset.id).toBe(categoryOf.get(preset.clauseId));
    }
  });

  it('does not let one shared word decide', () => {
    // "prohibited" alone used to mean a logging ban.
    expect(inferRuleCategoryFromProse('Transfer to us-east-1 is strictly prohibited.')).toBe('CROSS_BORDER_TRANSFER');
    // Mentioning logs does not make a retention rule a logging ban.
    expect(inferRuleCategoryFromProse('Access logs must be retained for no longer than 90 days.')).toBe(
      'RETENTION_AND_TENANT_KMS'
    );
    // An audit log requirement inside an AI oversight rule stays an AI rule.
    expect(
      inferRuleCategoryFromProse(
        'Model decisions below 0.9 confidence need human review, and every decision is written to an audit log.'
      )
    ).toBe('AI_HUMAN_IN_THE_LOOP');
    expect(
      inferRuleCategoryFromProse(
        'The data subject has the right to erasure of personal data; deletion must cascade to linked records.'
      )
    ).toBe('RIGHT_TO_ERASURE_CASCADE');
    expect(inferRuleCategoryFromProse('All PII columns must be encrypted at rest with AES-256.')).toBe(
      'ENCRYPTION_AT_REST'
    );
    expect(inferRuleCategoryFromProse('Never write unredacted email addresses to application logs.')).toBe(
      'PII_LOGGING_BAN'
    );
  });

  it('classifies the official EUR-Lex articles the feed tracks', () => {
    expect(
      inferRuleCategoryFromProse(
        '1. High-risk AI systems shall be designed and developed in such a way, including with appropriate human-machine interface tools, that they can be effectively overseen by natural persons during the period in which they are in use.'
      )
    ).toBe('AI_HUMAN_IN_THE_LOOP');
    expect(
      inferRuleCategoryFromProse(
        '1. The data subject shall have the right to obtain from the controller the erasure of personal data concerning him or her without undue delay.'
      )
    ).toBe('RIGHT_TO_ERASURE_CASCADE');
  });

  it('falls back when the text names no code-checkable obligation', () => {
    expect(inferRuleCategoryFromProse('This agreement is governed by the laws of Germany.')).toBe(
      'RETENTION_AND_TENANT_KMS'
    );
    expect(inferRuleCategoryFromProse('This agreement is governed by the laws of Germany.', 'ENCRYPTION_AT_REST')).toBe(
      'ENCRYPTION_AT_REST'
    );
    expect(inferRuleCategoryWithEvidence('Which fields does the patient intake payload collect?')).toBeNull();
    expect(inferRuleCategoryWithEvidence('Never write unredacted email addresses to application logs.')).toBe('PII_LOGGING_BAN');
  });
});
