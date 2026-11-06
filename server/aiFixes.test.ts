import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGateway } from './ai/gateway.js';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase, type Db } from './db/index.js';
import { aiSuggestionsFor } from './github/aiFixes.js';
import { compileClauseSync } from './product/clauses.js';
import { classifyFindings, scanFilesScoped } from './product/scanner.js';
import { ProductStore, type RuleInEffect } from './product/store.js';
import type { TargetRepoFile } from '../shared/types.js';

const LOGGING = '    logger.info(f"new application phone={applicant.phone} national_id={applicant.national_id}")';
const LOANS = [
  'import logging',
  '',
  'from api.privacy import redact_pii',
  '',
  'logger = logging.getLogger("finhealth.loans")',
  '',
  '',
  'def create_application(applicant, x_tenant_id):',
  LOGGING,
  '    return {"status": "received"}',
  '',
].join('\n');
const PRIVACY = ['import hashlib', '', '', 'def redact_pii(value: str) -> str:', '    return "[REDACTED:" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:12] + "]"', ''].join('\n');
const lang = (p: string) => (p.endsWith('.sql') ? 'sql' : p.endsWith('.ts') ? 'typescript' : 'python') as TargetRepoFile['language'];
const files: TargetRepoFile[] = Object.entries({ ...Object.fromEntries(Object.entries(INITIAL_REPO_FILES).map(([p, s]) => [p, s.content])), 'api/privacy.py': PRIVACY, 'api/loans.py': LOANS }).map(([path, content]) => ({
  path,
  language: lang(path),
  description: '',
  content,
  lastModified: '',
}));

/** Answers in turn; each answer is the `replacement` the fake model proposes. */
const answers: string[] = [];
let llm: http.Server;
let db: Db;
let ws: string;
let ai: AiGateway;
let rule: RuleInEffect;

beforeAll(async () => {
  llm = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const replacement = answers.shift() ?? LOGGING;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ replacement, note: 'Redact the values before logging.' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 30 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  db = openDatabase(':memory:');
  ws = new ProductStore(db).createWorkspace('W', null).id;
  ai = new AiGateway(db, {
    env: { LEXCOMPILER_LLM_PROVIDER: 'openai', LEXCOMPILER_LLM_MODEL: 'fake-cloud', LEXCOMPILER_LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, LEXCOMPILER_LLM_API_KEY: 'test' },
  });
  const c = getInitialClauses()[1];
  rule = { ruleId: 'r2', ruleKey: 'R-2', versionId: 'v', version: 1, clause: compileClauseSync({ text: c.rawLegalText, key: 'R-2', title: c.title, citation: c.citation, category: c.category }), clauseSha256: 'x', scope: { all: true } };
});

afterAll(() => {
  llm?.close();
  db?.close();
});

async function run(log: string[]) {
  const scan = await scanFilesScoped(files, [rule], new Map());
  const findings = classifyFindings(scan.findings, [], []);
  const target = findings.filter((f) => f.filePath === 'api/loans.py');
  expect(target).toHaveLength(1);
  return aiSuggestionsFor({
    ai,
    workspaceId: ws,
    files,
    findings: target,
    allFindings: findings,
    rules: [rule],
    globs: new Map(),
    diffLines: new Map([['api/loans.py', new Set(LOANS.split('\n').map((_, i) => i + 1))]]),
    log: (m) => log.push(m),
  });
}

describe('model-written fixes (5.5 item 2)', () => {
  it('asks no model unless the workspace chose a cloud provider', async () => {
    ai.setSettings(ws, { mode: 'local' }, 'owner');
    expect(await run([])).toEqual([]);
    expect(ai.listCalls(ws)).toHaveLength(0);
  });

  it('keeps a patch only when the file parses, Z3 no longer finds the rule there, and nothing new appears', async () => {
    ai.setSettings(ws, { mode: 'cloud' }, 'owner');
    const fixed = '    logger.info(f"new application phone={redact_pii(applicant.phone)} national_id={redact_pii(applicant.national_id)}")';

    answers.push('    logger.info(f"new application phone={applicant.phone"');
    const log: string[] = [];
    expect(await run(log)).toEqual([]);
    expect(log[0]).toMatch(/patch for R-2 at api\/loans\.py:9 discarded: the file no longer parses/);

    answers.push(LOGGING);
    const log2: string[] = [];
    expect(await run(log2)).toEqual([]);
    expect(log2[0]).toMatch(/discarded: Z3 still finds R-2/);

    answers.push(fixed);
    const [suggestion] = await run([]);
    expect(suggestion).toMatchObject({ ruleKey: 'R-2', path: 'api/loans.py', startLine: 9, line: 9 });
    expect(suggestion.body).toContain(`\`\`\`suggestion\n${fixed}\n\`\`\``);
    expect(suggestion.body).toContain('AI-suggested fix (fake-cloud)');
    // Each attempt is a logged model call.
    expect(ai.listCalls(ws).filter((c) => c.task === 'fix')).toHaveLength(3);
  });
});
