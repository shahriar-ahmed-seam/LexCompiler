import { describe, expect, it } from 'vitest';
import { definedNames, undefinedCalls } from './github/fixNames.js';
import type { TargetRepoFile } from '../shared/types.js';

const file = (path: string, content: string): TargetRepoFile => ({
  path,
  content,
  language: path.endsWith('.py') ? 'python' : path.endsWith('.sql') ? 'sql' : 'typescript',
  description: '',
  lastModified: '',
});

const PRIVACY = file('api/privacy.py', 'import hashlib\n\n\ndef redact_pii(value: str) -> str:\n    return hashlib.sha256(value.encode()).hexdigest()\n');
const LOANS = file('api/loans.py', 'import logging\nfrom api.privacy import redact_pii\n\nlogger = logging.getLogger("x")\n\n\ndef create(applicant):\n    logger.info(applicant.phone)\n');

describe('undefinedCalls', () => {
  it('flags a helper nothing defines, as in the live run', () => {
    const lines = ['    record = encrypt_with_tenant_kms(applicant.national_id, tenant_id)'];
    expect(undefinedCalls(LOANS, lines, [PRIVACY, LOANS])).toEqual(['encrypt_with_tenant_kms']);
  });

  it('accepts imported names, names defined in other files, builtins and method calls', () => {
    const lines = ['    logger.info(redact_pii(str(applicant.phone)), len(applicant.name))'];
    expect(undefinedCalls(LOANS, lines, [PRIVACY, LOANS])).toEqual([]);
  });

  it('accepts a function defined in the patched file itself', () => {
    const patched = file('api/loans.py', `${LOANS.content}\n\ndef mask(v):\n    return "***"\n`);
    expect(undefinedCalls(patched, ['    logger.info(mask(applicant.phone))'], [PRIVACY, LOANS])).toEqual([]);
  });

  it('ignores names inside strings and comments', () => {
    expect(undefinedCalls(LOANS, ['    logger.info("call encrypt_now(x) later")  # todo: encrypt_now(x)'], [LOANS])).toEqual([]);
  });

  it('checks TypeScript too, with its own builtins and imports', () => {
    const ts = file('services/triage.ts', "import { gate } from './gate';\nexport function run() {}\n");
    const lines = ['  if (gate(score) && Number.isFinite(score)) return requireHumanReview(String(score));'];
    expect(undefinedCalls(ts, lines, [ts])).toEqual(['requireHumanReview']);
  });

  it('skips SQL, whose functions belong to the database', () => {
    expect(undefinedCalls(file('schema/a.sql', ''), ['  ssn TEXT DEFAULT pgp_sym_encrypt(x)'], [])).toEqual([]);
  });
});

describe('definedNames', () => {
  it('reads Python imports with aliases and parenthesised lists', () => {
    const f = file('a.py', 'from x import (a, b as c)\nimport os.path as p, json\n');
    expect([...definedNames(f)].sort()).toEqual(['a', 'c', 'json', 'p']);
  });

  it('reads TypeScript default, named, namespace and destructured declarations', () => {
    const f = file('a.ts', "import d, { e as f, type G } from 'm';\nimport * as ns from 'n';\nconst { h, i: j } = obj;\n");
    expect([...definedNames(f)].sort()).toEqual(['G', 'd', 'f', 'h', 'j', 'ns']);
  });
});
