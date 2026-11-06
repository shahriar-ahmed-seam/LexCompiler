import { enterScratchFixtureCopy } from './cli/scratchFixture.js';

/**
 * Retrieval evaluation over a labelled dataset; LEXCOMPILER_JUDGE_* (or LEXCOMPILER_LLM_*) adds the LLM judge.
 *   npm run eval:rag                          # English questions on the bundled fixture
 *   npm run eval:rag -- --dataset bn          # Bangla questions with the Bangla clause set
 *   LEXCOMPILER_TARGET_REPO=<finhealth-core-platform clone> npm run eval:rag -- --dataset finhealth
 */
const DATASETS: Record<string, { file: string; clauses: 'en' | 'bn'; needsRepo: boolean }> = {
  fixture: { file: 'dataset.json', clauses: 'en', needsRepo: false },
  bn: { file: 'dataset.bn.json', clauses: 'bn', needsRepo: false },
  finhealth: { file: 'dataset.finhealth.json', clauses: 'en', needsRepo: true },
};

async function main() {
  const name = process.argv[process.argv.indexOf('--dataset') + 1] && process.argv.includes('--dataset') ? process.argv[process.argv.indexOf('--dataset') + 1] : 'fixture';
  const spec = DATASETS[name];
  if (!spec) throw new Error(`Unknown dataset "${name}" (${Object.keys(DATASETS).join(', ')})`);
  if (spec.needsRepo && !process.env.LEXCOMPILER_TARGET_REPO) throw new Error(`--dataset ${name} needs LEXCOMPILER_TARGET_REPO set to a clone of the test repository`);
  if (!spec.needsRepo) enterScratchFixtureCopy('eval-rag');
  const { analyzeFullRepositoryAsync } = await import('./analyzer/astAnalyzer.js');
  const { readTargetRepoFiles } = await import('./analyzer/repoBaseline.js');
  const { getBanglaInitialClauses, getInitialClauses } = await import('./compiler/legalCompiler.js');
  const { verifyRepositoryAgainstClauses } = await import('./prover/z3Engine.js');
  const { executeStoreBackedRagQuery } = await import('./rag/hybridRagEngine.js');
  const { evaluateRag, loadEvalDataset } = await import('./rag/evaluation.js');
  const path = await import('node:path');
  const { llmConfigFor } = await import('./agents/llmClient.js');
  const clauses = spec.clauses === 'bn' ? getBanglaInitialClauses() : getInitialClauses();
  const dataset = loadEvalDataset(path.join(process.cwd(), 'server/rag/eval', spec.file));
  const a = await analyzeFullRepositoryAsync(readTargetRepoFiles());
  const v = await verifyRepositoryAgainstClauses(clauses, a.sqlTables, a.astFindings);
  const judge = llmConfigFor('agent-rag-judge');
  const report = await evaluateRag((q, k) => executeStoreBackedRagQuery(q, clauses, a.sqlTables, a.astFindings, v.proofs, k), { judge, dataset });
  console.log(`RAG evaluation (${name}): ${report.questions} labelled questions, k=${report.k}${report.judgeModel ? `, judge ${report.judgeModel}` : ' (no judge model configured)'}`);
  for (const p of report.perQuestion) {
    console.log(`  ${p.id} P@k=${p.scores.precisionAtK.toFixed(2)} R@k=${p.scores.recallAtK.toFixed(2)} MRR=${p.scores.mrr.toFixed(2)} nDCG=${p.scores.ndcgAtK.toFixed(2)}${p.judge ? ` faith=${p.judge.faithfulness.toFixed(2)} rel=${p.judge.answerRelevancy.toFixed(2)}` : ''}${p.judgeError ? ` judge-error=${JSON.stringify(p.judgeError)}` : ''}  ${p.query}`);
  }
  console.log(`Aggregate: ${JSON.stringify(report.aggregate)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
