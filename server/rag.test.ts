import { describe, expect, it } from 'vitest';
import { analyzeFullRepositoryAsync } from './analyzer/astAnalyzer.js';
import { readTargetRepoFiles } from './analyzer/repoBaseline.js';
import { getInitialClauses } from './compiler/legalCompiler.js';
import { verifyRepositoryAgainstClauses } from './prover/z3Engine.js';
import { CYPHER, createInMemoryGraphStore, createNeo4jGraphStore, entityEdges, type Neo4jDriverLike } from './rag/graphStore.js';
import { bm25Tokens, executeHybridRagQuery, executeStoreBackedRagQuery, stemToken } from './rag/hybridRagEngine.js';
import { openPgliteVectorStore } from './rag/vectorStore.js';

const unit = (i: number, dims = 8) => Array.from({ length: dims }, (_, j) => (j === i % dims ? 1 : 0.01 * ((i + j) % 3)));

describe('pgvector store', () => {
  it('ranks by the HNSW cosine index, refreshes changed rows, and drops removed ones', async () => {
    const store = await openPgliteVectorStore('test', 8);
    try {
      expect(store.backend).toMatch(/^pgvector \d/);
      await store.sync([0, 1, 2].map((i) => ({ id: `c${i}`, text: `t${i}`, embedding: unit(i) })));
      const first = [...(await store.search(unit(1), 3)).keys()];
      expect(first[0]).toBe('c1');
      await store.sync([{ id: 'c0', text: 't0', embedding: unit(0) }, { id: 'c2', text: 'changed', embedding: unit(1) }]);
      const second = await store.search(unit(1), 5);
      expect([...second.keys()]).toEqual(['c2', 'c0']);
      await expect(store.sync([{ id: 'x', text: 'x', embedding: [1, 2] }])).rejects.toThrow(/dimensions/);
    } finally {
      await store.close();
    }
  });

  it('returns more than the default ef_search (40) candidates when asked', async () => {
    const store = await openPgliteVectorStore('wide', 8);
    try {
      await store.sync(Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, text: `t${i}`, embedding: unit(i) })));
      expect((await store.search(unit(3), 60)).size).toBe(60);
    } finally {
      await store.close();
    }
  });
});

/** Fake driver that answers the generated Cypher by evaluating it over the loaded edges. */
function fakeNeo4j(): Neo4jDriverLike & { cypher: string[] } {
  const memory = createInMemoryGraphStore();
  let edges: ReturnType<typeof entityEdges> = [];
  const cypher: string[] = [];
  const rec = (o: Record<string, unknown>) => ({ get: (k: string) => o[k] });
  return {
    cypher,
    async executeQuery(q, params = {}) {
      cypher.push(q);
      if (q === CYPHER.load) {
        edges = params.edges as typeof edges;
        await memory.load(edges.map((e) => ({ subject: e.from, predicate: e.predicate, object: e.to })) as never);
      }
      if (q.startsWith('MATCH (s:LexEntity')) {
        const nodes = new Set(edges.flatMap((e) => [e.from, e.to]));
        const seeds = (params.seeds as string[]).filter((s) => nodes.has(s));
        const dist = await memory.distancesFrom(seeds, Number(/\*0\.\.(\d)/.exec(q)![1]));
        return { records: [...dist].map(([key, hops]) => rec({ key, hops: { toNumber: () => hops } })) };
      }
      if (q === CYPHER.entities) return { records: [...new Set(edges.flatMap((e) => [e.from, e.to]))].map((key) => rec({ key })) };
      return { records: [] };
    },
    async close() {},
  };
}

describe('store-backed Graph RAG', () => {
  it('matches the in-process pipeline when run through pgvector and a graph store', async () => {
    const clauses = getInitialClauses();
    const { sqlTables, astFindings } = await analyzeFullRepositoryAsync(readTargetRepoFiles());
    const { proofs } = await verifyRepositoryAgainstClauses(clauses, sqlTables, astFindings);
    const query = 'Which Python endpoints log plaintext SSN or email?';
    const baseline = executeHybridRagQuery(query, clauses, sqlTables, astFindings, proofs, 5);

    const vectorStore = await openPgliteVectorStore('feature-hash', 384);
    const driver = fakeNeo4j();
    try {
      const viaStores = await executeStoreBackedRagQuery(query, clauses, sqlTables, astFindings, proofs, 5, {
        vectorStore,
        graphStore: createNeo4jGraphStore(driver),
        crossEncoder: null,
      });
      expect(viaStores.vectorDbBackend).toMatch(/pgvector/);
      expect(viaStores.graphDbBackend).toMatch(/Neo4j/);
      expect(driver.cypher).toContain(CYPHER.load);
      expect(viaStores.retrievedChunks.map((r) => r.chunk.chunkId)).toEqual(baseline.retrievedChunks.map((r) => r.chunk.chunkId));
      viaStores.retrievedChunks.forEach((r, i) => {
        expect(r.denseVectorScore).toBeCloseTo(baseline.retrievedChunks[i].denseVectorScore, 2);
        expect(r.graphTraversalBoost).toBe(baseline.retrievedChunks[i].graphTraversalBoost);
      });

      // A cross-encoder decides the final order.
      const reranked = await executeStoreBackedRagQuery(query, clauses, sqlTables, astFindings, proofs, 3, {
        vectorStore,
        graphStore: createInMemoryGraphStore(),
        crossEncoder: { name: 'fake', score: async (_q, passages) => passages.map((p) => (p.includes('logger') ? 1 : 0)) },
      });
      expect(reranked.ragasMetrics.evaluationMethod).toContain('reranker: fake');
      expect(reranked.retrievedChunks[0].crossEncoderRerankScore).toBe(1);
    } finally {
      await vectorStore.close();
    }
  });
});

describe('BM25 terms', () => {
  it('stems plurals, -ing, -ed and -ion, and leaves codes and paths alone', () => {
    expect(['fields', 'collect', 'collected', 'collection', 'collects'].map(stemToken)).toEqual(['field', 'collect', 'collect', 'collect', 'collect']);
    expect(['logs', 'logged', 'logging', 'policies', 'addresses', 'status', 'basis'].map(stemToken)).toEqual(['log', 'log', 'log', 'policy', 'address', 'status', 'basis']);
    expect(['ssn', 'us-east-1', 'fastapi_intake.py', 'aes256'].map(stemToken)).toEqual(['ssn', 'us-east-1', 'fastapi_intake.py', 'aes256']);
  });

  it('adds the parts of camelCase, snake_case and dotted identifiers', () => {
    const t = bm25Tokens('{"collectedPiiFields":["full_name"]} PatientIntakePayload api/fastapi_intake.py');
    expect(t).toEqual(expect.arrayContaining(['collectedpiifield', 'collect', 'pii', 'field', 'full_name', 'full', 'name', 'patientintakepayload', 'patient', 'intake', 'payload', 'fastapi_intake.py', 'fastapi', 'py']));
  });

  it('finds the collection model for "which fields does … collect" questions', async () => {
    const clauses = getInitialClauses();
    const a = await analyzeFullRepositoryAsync(readTargetRepoFiles());
    const v = await verifyRepositoryAgainstClauses(clauses, a.sqlTables, a.astFindings);
    const top = executeHybridRagQuery('Which fields does the patient intake payload collect?', clauses, a.sqlTables, a.astFindings, v.proofs, 5).retrievedChunks.map((r) => r.chunk.chunkId);
    expect(top).toContain('chunk-ast-ast-py-model-api/fastapi_intake.py-PatientIntakePayload');
  });
});
