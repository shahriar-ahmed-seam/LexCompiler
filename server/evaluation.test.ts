import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { analyzeFullRepositoryAsync } from './analyzer/astAnalyzer.js';
import { readTargetRepoFiles } from './analyzer/repoBaseline.js';
import { getBanglaInitialClauses, getInitialClauses } from './compiler/legalCompiler.js';
import { verifyRepositoryAgainstClauses } from './prover/z3Engine.js';
import { evaluateRag, judgeAnswer, loadEvalDataset, scoreRanking } from './rag/evaluation.js';
import { executeHybridRagQuery } from './rag/hybridRagEngine.js';

describe('retrieval evaluation', () => {
  it('computes standard IR metrics', () => {
    const s = scoreRanking(['x', 'a', 'b'], { a: 2, b: 1, c: 1 }, 3);
    expect(s.precisionAtK).toBeCloseTo(2 / 3);
    expect(s.recallAtK).toBeCloseTo(2 / 3);
    expect(s.mrr).toBe(0.5);
    const dcg = 3 / Math.log2(3) + 1 / Math.log2(4);
    const ideal = 3 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4);
    expect(s.ndcgAtK).toBeCloseTo(dcg / ideal);
  });

  it('labels only chunks that exist and keeps retrieval quality above the regression floor', async () => {
    const clauses = getInitialClauses();
    const a = await analyzeFullRepositoryAsync(readTargetRepoFiles());
    const v = await verifyRepositoryAgainstClauses(clauses, a.sqlTables, a.astFindings);
    const all = executeHybridRagQuery('x', clauses, a.sqlTables, a.astFindings, v.proofs, 100).retrievedChunks.map((r) => r.chunk.chunkId);
    for (const q of loadEvalDataset()) for (const id of Object.keys(q.relevant)) expect(all).toContain(id);
    const report = await evaluateRag(async (q, k) => executeHybridRagQuery(q, clauses, a.sqlTables, a.astFindings, v.proofs, k));
    expect(report.questions).toBe(16);
    // Measured on the fixture: MRR 0.88, nDCG@5 0.795, hit rate 1.0 (0.786, 0.64, 0.938 before stemmed BM25).
    expect(report.aggregate.mrr).toBeGreaterThanOrEqual(0.85);
    expect(report.aggregate.ndcgAtK).toBeGreaterThanOrEqual(0.75);
    expect(report.aggregate.hitRate).toBe(1);
  });

  it('Bangla questions over the Bangla clause set stay above the regression floor', async () => {
    const clauses = getBanglaInitialClauses();
    const a = await analyzeFullRepositoryAsync(readTargetRepoFiles());
    const v = await verifyRepositoryAgainstClauses(clauses, a.sqlTables, a.astFindings);
    const dataset = loadEvalDataset(path.join(process.cwd(), 'server/rag/eval/dataset.bn.json'));
    const all = executeHybridRagQuery('x', clauses, a.sqlTables, a.astFindings, v.proofs, 100).retrievedChunks.map((r) => r.chunk.chunkId);
    for (const q of dataset) for (const id of Object.keys(q.relevant)) expect(all).toContain(id);
    const report = await evaluateRag(async (q, k) => executeHybridRagQuery(q, clauses, a.sqlTables, a.astFindings, v.proofs, k), { dataset });
    expect(report.questions).toBe(10);
    // Measured: MRR 0.95, nDCG@5 0.755, hit rate 1.0 (nDCG@5 0.597 before stemmed BM25).
    expect(report.aggregate.mrr).toBeGreaterThanOrEqual(0.9);
    expect(report.aggregate.ndcgAtK).toBeGreaterThanOrEqual(0.7);
    expect(report.aggregate.hitRate).toBe(1);
  });

  it('LLM judge: faithfulness is the share of supported claims', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const content = JSON.stringify({ claims: [{ claim: 'A', supported: true }, { claim: 'B', supported: true }, { claim: 'C', supported: false }], answerRelevancy: 0.8 });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const j = await judgeAnswer({ provider: 'openai', model: 'judge', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, 'q', 'a', ['ctx']);
      expect(j.faithfulness).toBeCloseTo(2 / 3);
      expect(j.answerRelevancy).toBe(0.8);
    } finally {
      server.close();
    }
  });

  it('LLM judge: retries truncated JSON once, and an unparseable verdict leaves the question unjudged', async () => {
    const valid = JSON.stringify({ claims: [{ claim: 'A', supported: true }], answerRelevancy: 0.5 });
    // Truncated reply (as when a judge hits its token limit mid-list), then valid on the corrective turn.
    let replies = ['{"claims":[{"claim":"A","supported":true},{"claim":"B"', valid];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? 'not json' }, finish_reason: 'length' }], usage: {} }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const judge = { provider: 'openai' as const, model: 'judge', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    try {
      expect((await judgeAnswer(judge, 'q', 'a', ['ctx'])).faithfulness).toBe(1);

      const clauses = getInitialClauses();
      const a = await analyzeFullRepositoryAsync(readTargetRepoFiles());
      const v = await verifyRepositoryAgainstClauses(clauses, a.sqlTables, a.astFindings);
      const dataset = loadEvalDataset().slice(0, 2);
      replies = [valid]; // first question judged; the second gets only invalid replies
      const report = await evaluateRag(async (q, k) => executeHybridRagQuery(q, clauses, a.sqlTables, a.astFindings, v.proofs, k), { judge, dataset });
      expect(report.perQuestion[0].judge?.faithfulness).toBe(1);
      expect(report.perQuestion[1].judge).toBeUndefined();
      expect(report.perQuestion[1].judgeError).toMatch(/did not return valid JSON/);
      expect(report.aggregate.judgedQuestions).toBe(1);
      expect(report.aggregate.faithfulness).toBe(1);
    } finally {
      server.close();
    }
  });
});
