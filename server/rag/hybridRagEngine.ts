import { performance } from 'node:perf_hooks';
import {
  computeRealNeuralEmbedding,
  runRealLlmInference,
} from '../services/realAiServiceMesh.js';
import { inferRuleCategoryWithEvidence } from '../compiler/legalCompiler.js';
import { countTokens } from '../optimization/tokenOptimizer.js';
import { getGraphStore, type GraphStore } from './graphStore.js';
import { getCrossEncoder } from './reranker.js';
import { getVectorStore, type VectorStore } from './vectorStore.js';
import type {
  ASTFindingNode,
  ClauseVerificationProof,
  ContextualRagChunk,
  KnowledgeGraphTriple,
  LegalClause,
  RagQueryExecutionReport,
  RagRetrievedItem,
  RuleCategory,
  SQLTableSchema,
} from '../../shared/types.js';

export const EMBEDDING_DIMENSIONS = 384;

/** Concept features: a hit on any synonym adds the concept token to the hashed vector. */
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  retention: ['retention', 'ttl', 'purge', 'expire', 'setex', 'delete', 'hours', 'days', 'ঘণ্টা', 'দিন'],
  tenant_kms: ['tenant', 'kms', 'envelope', 'tenant_kms_key_id', 'isolated', 'টেন্যান্ট'],
  encryption: ['encrypt', 'encrypted', 'aes', 'cipher', 'ciphertext'],
  logging: ['log', 'logger', 'logging', 'stdout', 'redact', 'plaintext', 'unredacted', 'লগ'],
  ai_oversight: ['confidence', 'human', 'oversight', 'triage', 'threshold', 'autonomous', 'audit'],
  residency: ['region', 'transfer', 'residency', 'sovereign', 'replica', 'egress', 'cross-border', 'us-east-1'],
  erasure: ['erasure', 'cascade', 'forgotten', 'foreign', 'references'],
  pii: ['ssn', 'email', 'phi', 'pii', 'diagnosis', 'patient', 'personal'],
};

function hashToken(token: string): { index: number; sign: number } {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return { index: (h >>> 0) % EMBEDDING_DIMENSIONS, sign: (h >>> 31) & 1 ? -1 : 1 };
}

/**
 * Deterministic 384-d embedding (signed feature hashing of unigrams, bigrams, and
 * domain concepts with sublinear term frequency), L2-normalized. Used whenever the
 * Ollama `all-minilm` model is not reachable.
 */
export function computeSemanticEmbedding(text: string): number[] {
  const tokens = tokenizeWords(text);
  const lower = text.toLowerCase();
  const counts = new Map<string, number>();
  const add = (t: string, w = 1) => counts.set(t, (counts.get(t) || 0) + w);
  tokens.forEach((t, i) => {
    add(t);
    if (i + 1 < tokens.length) add(`${t} ${tokens[i + 1]}`, 0.5);
  });
  for (const [concept, words] of Object.entries(CONCEPT_SYNONYMS)) {
    const hits = words.filter((w) => lower.includes(w)).length;
    if (hits > 0) add(`concept:${concept}`, 2 * hits);
  }
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [token, c] of counts) {
    const { index, sign } = hashToken(token);
    vec[index] += sign * (1 + Math.log(c));
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : Math.round((dot / denom) * 1000) / 1000;
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Light English stemming for BM25: plural, -ing, -ed and -ion endings, so "fields" matches
 * "field" and "collect" matches "collected" or "collection". Tokens with digits, dots or
 * dashes (paths, regions, versions) and short words stay as they are.
 */
export function stemToken(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suffix of ['ions', 'ion', 'ing', 'ed']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
      w = w.slice(0, -suffix.length);
      // "logged" → "logg" → "log"; "stopping" → "stop"
      if (/([^aeiouslz])\1$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  return w;
}

/**
 * BM25 terms: each word, plus the parts of identifiers (camelCase, snake_case and dotted
 * names), stemmed. "collectedPiiFields" yields collect, pii and field next to the whole name.
 */
export function bm25Tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_.-]+/)) {
    if (!raw) continue;
    const whole = raw.toLowerCase();
    if (whole.length > 1) out.push(stemToken(whole));
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_.-]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1);
    if (parts.length > 1) for (const p of parts) out.push(stemToken(p));
  }
  return out;
}

/**
 * Builds Anthropic-style Contextual RAG chunks + Variable Semantic Chunking
 * across Legal Statutes, Polyglot AST Nodes, SQL Tables, and Z3 Formal Proofs.
 */
export function buildContextualRagCorpus(
  clauses: LegalClause[],
  sqlTables: SQLTableSchema[],
  astFindings: ASTFindingNode[],
  proofs: ClauseVerificationProof[]
): {
  chunks: ContextualRagChunk[];
  triples: KnowledgeGraphTriple[];
} {
  const chunks: ContextualRagChunk[] = [];
  const triples: KnowledgeGraphTriple[] = [];

  // 1. Contextual Chunks for Legal Statutes (Semantic Proposition Chunking)
  for (const clause of clauses) {
    const prefix = `[Anthropic Contextual RAG Prefix | Statute: ${clause.frameworkName} (${clause.citation}) | Modality: ${clause.deontic.modality} ${clause.deontic.deonticOperatorSymbol} | Target Scope: ${clause.deontic.targetDataScope.join(', ')} | Formal Predicate: ${clause.deontic.formalPredicateSummary}]`;
    const rawChunkText = `${clause.title}: ${clause.rawLegalText}`;
    const contextualizedText = `${prefix}\n${rawChunkText}`;

    chunks.push({
      chunkId: `chunk-law-${clause.id}`,
      sourceType: 'LEGAL_STATUTE',
      sourceId: clause.id,
      citationOrPath: clause.citation,
      chunkStrategy: 'SEMANTIC_PROPOSITION',
      rawChunkText,
      anthropicContextualPrefix: prefix,
      contextualizedText,
      tokenCount: countTokens(contextualizedText),
      embeddingDimension: EMBEDDING_DIMENSIONS,
      embeddingPreview: computeSemanticEmbedding(contextualizedText).slice(0, 12),
      linkedGraphEntities: [clause.id, clause.citation, ...clause.deontic.targetDataScope],
    });

    triples.push({
      id: `triple-${clause.id}-deontic`,
      subject: clause.citation,
      subjectType: 'STATUTE',
      predicate: 'IMPOSES_OBLIGATION',
      object: clause.deontic.formalPredicateSummary,
      objectType: 'DEONTIC_RULE',
      cypherQuerySnippet: `MATCH (s:Statute {id: "${clause.id}"})-[:IMPOSES_OBLIGATION]->(d:DeonticRule) RETURN s, d`,
    });
  }

  // 2. Contextual Chunks for SQL DDL Schemas
  for (const table of sqlTables) {
    const piiCols = table.columns.filter((c) => c.isPII).map((c) => c.name);
    const prefix = `[Anthropic Contextual RAG Prefix | SQL Schema: ${table.filePath}:${table.startLine}-${table.endLine} | Table: ${table.tableName} | PII Columns: ${piiCols.join(', ') || 'none'} | Retention Hours: ${table.retentionHoursConfigured ?? 'unset'}h | Tenant KMS Isolated: ${table.hasTenantKeyIsolation}]`;
    const rawChunkText = `TABLE ${table.tableName} (${table.columns.map((c) => `${c.name} ${c.dataType}`).join(', ')}) — retention=${table.retentionHoursConfigured ?? 'unset'}h, hasTenantKeyIsolation=${table.hasTenantKeyIsolation}`;
    const contextualizedText = `${prefix}\n${rawChunkText}`;

    chunks.push({
      chunkId: `chunk-sql-${table.tableName}`,
      sourceType: 'SQL_DDL_SCHEMA',
      sourceId: `sql:${table.tableName}`,
      citationOrPath: `${table.filePath}:${table.startLine}`,
      chunkStrategy: 'AST_SUBTREE',
      rawChunkText,
      anthropicContextualPrefix: prefix,
      contextualizedText,
      tokenCount: countTokens(contextualizedText),
      embeddingDimension: EMBEDDING_DIMENSIONS,
      embeddingPreview: computeSemanticEmbedding(contextualizedText).slice(0, 12),
      linkedGraphEntities: [
        table.tableName,
        ...piiCols,
        ...clauses
          .filter((c) => ['RETENTION_AND_TENANT_KMS', 'ENCRYPTION_AT_REST', 'RIGHT_TO_ERASURE_CASCADE'].includes(c.category))
          .map((c) => c.id),
      ],
    });

    for (const col of piiCols) {
      triples.push({
        id: `triple-sql-${table.tableName}-${col}`,
        subject: `AST::${table.filePath}`,
        subjectType: 'AST_NODE',
        predicate: 'PERSISTS_IN_COLUMN',
        object: `${table.tableName}.${col}`,
        objectType: 'SQL_COLUMN',
        cypherQuerySnippet: `MATCH (t:SQLTable {name: "${table.tableName}"})-[:HAS_PII_COLUMN]->(c:Column {name: "${col}"}) RETURN t, c`,
      });
    }
  }

  // 3. Contextual Chunks for Polyglot AST Findings (Late Chunking)
  for (const finding of astFindings) {
    const prefix = `[Anthropic Contextual RAG Prefix | Polyglot AST (${finding.language.toUpperCase()}) | File: ${finding.filePath}:${finding.line}-${finding.endLine} | AST Node: ${finding.astNodeKind} | Construct: ${finding.constructType} | Metadata: ${JSON.stringify(finding.metadata)}]`;
    const rawChunkText = `${finding.functionName} in ${finding.filePath}:\n${finding.codeSnippet}`;
    const contextualizedText = `${prefix}\n${rawChunkText}`;

    chunks.push({
      chunkId: `chunk-ast-${finding.id}`,
      sourceType: 'POLYGLOT_AST_NODE',
      sourceId: finding.id,
      citationOrPath: `${finding.filePath}:${finding.line}`,
      chunkStrategy: 'LATE_CHUNKING',
      rawChunkText,
      anthropicContextualPrefix: prefix,
      contextualizedText,
      tokenCount: countTokens(contextualizedText),
      embeddingDimension: EMBEDDING_DIMENSIONS,
      embeddingPreview: computeSemanticEmbedding(contextualizedText).slice(0, 12),
      linkedGraphEntities: [finding.filePath, finding.functionName, finding.constructType],
    });
  }

  // 4. Contextual Chunks for Z3 SMT-LIB2 Proofs & Unsat Cores
  for (const proof of proofs) {
    const prefix = `[Anthropic Contextual RAG Prefix | Z3 Formal Proof (${proof.status}) | Statute: ${proof.citation} | Solver Time: ${proof.z3SolveTimeMs}ms | Unsat Core: ${proof.unsatCoreAssertions.join(', ') || 'SAT_EMPTY'} | Affected Nodes: ${proof.affectedGraphNodeIds.join(', ')}]`;
    const rawChunkText = `${proof.smtLib2Executed}\nOPA Rego Denials: ${proof.opaRegoTriggeredDenials.join(' | ') || 'None'}`;
    const contextualizedText = `${prefix}\n${rawChunkText}`;

    chunks.push({
      chunkId: `chunk-proof-${proof.clauseId}`,
      sourceType: 'FORMAL_SMT_AXIOM',
      sourceId: `proof:${proof.clauseId}`,
      citationOrPath: `Z3::${proof.citation}`,
      chunkStrategy: 'SEMANTIC_PROPOSITION',
      rawChunkText,
      anthropicContextualPrefix: prefix,
      contextualizedText,
      tokenCount: countTokens(contextualizedText),
      embeddingDimension: EMBEDDING_DIMENSIONS,
      embeddingPreview: computeSemanticEmbedding(contextualizedText).slice(0, 12),
      linkedGraphEntities: [
        proof.clauseId,
        proof.citation,
        ...proof.affectedGraphNodeIds,
        ...proof.offendingLocations.map((l) => l.filePath),
      ],
    });

    for (const loc of proof.offendingLocations) {
      triples.push({
        id: `triple-violation-${proof.clauseId}-${loc.nodeId}`,
        subject: `${loc.filePath}:${loc.line}`,
        subjectType: 'AST_NODE',
        predicate: 'VIOLATES_INVARIANT',
        object: `${proof.citation} (${proof.unsatCoreAssertions[0] || 'UNSAT'})`,
        objectType: 'SMT_ASSERTION',
        cypherQuerySnippet: `MATCH (n:ASTNode {id: "${loc.nodeId}"})-[:VIOLATES_INVARIANT]->(a:SMTAssertion {clause: "${proof.clauseId}"}) RETURN n, a`,
      });
    }
  }

  return { chunks, triples };
}

interface RetrievalOptions {
  /** Dense similarity per chunk id (pgvector search); in-memory feature-hashed cosine otherwise. */
  denseScores?: Map<string, number>;
  denseBackend?: string;
  vectorDbBackend?: string;
  /** Entity hop distances from a graph store (Neo4j / in-memory); computed in-process otherwise. */
  entityDistances?: Map<string, number>;
  graphDbBackend?: string;
  /** Cross-encoder relevance per chunk id; the final order follows it when present. */
  rerankScores?: Map<string, number>;
  rerankBackend?: string;
}

/**
 * Graph seeds: entities named in the query plus the ids of the query category's clauses. With no
 * category evidence (`category` null) only named entities seed the traversal.
 */
export function graphSeeds(query: string, category: RuleCategory | null, clauses: LegalClause[], entities: Iterable<string>): string[] {
  const q = query.toLowerCase();
  const seeds = new Set<string>();
  for (const node of entities) {
    if (node.startsWith('chunk:') || node.length < 4) continue;
    if (q.includes(node)) seeds.add(node);
  }
  if (category) for (const c of clauses.filter((x) => x.category === category)) seeds.add(c.id.toLowerCase());
  return [...seeds];
}

function chunkDistancesFrom(dist: Map<string, number>, chunks: ContextualRagChunk[], triples: KnowledgeGraphTriple[]) {
  const chunkDistance = new Map<string, number>();
  for (const c of chunks) {
    const ds = c.linkedGraphEntities.map((e) => dist.get(e.toLowerCase())).filter((d): d is number => d !== undefined);
    if (ds.length > 0) chunkDistance.set(c.chunkId, Math.min(...ds));
  }
  const reachedTriples = triples.filter((t) => dist.has(t.subject.toLowerCase()) || dist.has(t.object.toLowerCase()));
  return { chunkDistance, reachedTriples };
}

/**
 * The query's category and a HyDE expansion from that category's clause. The category comes from
 * the wording, or else from a clause whose citation the query names ("বাংলাদেশ ব্যাংক ধারা ৪.২").
 * A query with neither ("which fields does the payload collect?") keeps the retention fallback for
 * the answer, but gets no expansion and no category graph seeds, which would rank the retention
 * clause first.
 */
function categoryHyde(query: string, clauses: LegalClause[]): { category: RuleCategory; seedCategory: RuleCategory | null; hyde: string } {
  const q = query.toLowerCase();
  const named = clauses.find((c) =>
    c.citation
      .split('/')
      .map((part) => part.trim().toLowerCase())
      .some((part) => part.length >= 4 && q.includes(part))
  );
  const seedCategory = inferRuleCategoryWithEvidence(query) ?? named?.category ?? null;
  const category = seedCategory ?? 'RETENTION_AND_TENANT_KMS';
  if (!seedCategory) return { category, seedCategory, hyde: '' };
  const clause = clauses.find((c) => c.category === category);
  const hyde = clause
    ? clause.compiled.smtLib2Snippet
        .split('\n')
        .filter((l) => l.startsWith('(assert'))
        .join(' ')
    : `(assert true) ; no active clause for ${category}`;
  return { category, seedCategory, hyde: `${hyde} ; HyDE expansion for: ${query}` };
}

/** 2-hop traversal of the statute ↔ code knowledge graph from entities named in the query. */
function graphDistances(
  query: string,
  category: RuleCategory | null,
  clauses: LegalClause[],
  chunks: ContextualRagChunk[],
  triples: KnowledgeGraphTriple[]
): { chunkDistance: Map<string, number>; reachedTriples: KnowledgeGraphTriple[] } {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const ka = a.toLowerCase();
    const kb = b.toLowerCase();
    if (!adj.has(ka)) adj.set(ka, new Set());
    if (!adj.has(kb)) adj.set(kb, new Set());
    adj.get(ka)!.add(kb);
    adj.get(kb)!.add(ka);
  };
  for (const t of triples) link(t.subject, t.object);
  for (const c of chunks) for (const e of c.linkedGraphEntities) link(`chunk:${c.chunkId}`, e);
  for (const t of triples) {
    // `${file}:${line}` subjects connect to their file node
    const file = t.subject.replace(/^AST::/, '').replace(/:\d+$/, '');
    if (file !== t.subject) link(t.subject, file);
  }

  const seeds = graphSeeds(query, category, clauses, adj.keys());

  const dist = new Map<string, number>();
  let frontier = [...seeds];
  frontier.forEach((n) => dist.set(n, 0));
  // Entity hops (chunk nodes do not count as a hop).
  for (let hop = 1; hop <= 2 && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) || []) {
        if (m.startsWith('chunk:')) continue;
        if (!dist.has(m)) {
          dist.set(m, hop);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  const chunkDistance = new Map<string, number>();
  for (const c of chunks) {
    const ds = c.linkedGraphEntities.map((e) => dist.get(e.toLowerCase())).filter((d): d is number => d !== undefined);
    if (ds.length > 0) chunkDistance.set(c.chunkId, Math.min(...ds));
  }
  const reachedTriples = triples.filter(
    (t) => dist.has(t.subject.toLowerCase()) || dist.has(t.object.toLowerCase())
  );
  return { chunkDistance, reachedTriples };
}

/** Relevance labels: chunks tied to clauses / proofs / constructs of the query's category. */
function isRelevant(chunk: ContextualRagChunk, category: RuleCategory, clauses: LegalClause[], proofs: ClauseVerificationProof[]): boolean {
  const ids = new Set(clauses.filter((c) => c.category === category).map((c) => c.id));
  if (chunk.linkedGraphEntities.some((e) => ids.has(e))) return true;
  if (chunk.sourceType === 'POLYGLOT_AST_NODE') {
    const paths = new Set(
      proofs
        .filter((p) => p.category === category)
        .flatMap((p) => [...p.offendingLocations.map((l) => l.filePath), ...(p.repairTargets || []).map((t) => t.filePath)])
    );
    return chunk.linkedGraphEntities.some((e) => paths.has(e));
  }
  return false;
}

function hybridRetrieve(
  query: string,
  clauses: LegalClause[],
  sqlTables: SQLTableSchema[],
  astFindings: ASTFindingNode[],
  proofs: ClauseVerificationProof[],
  topK: number,
  options: RetrievalOptions = {}
): RagQueryExecutionReport {
  const t0 = performance.now();
  const { chunks, triples } = buildContextualRagCorpus(clauses, sqlTables, astFindings, proofs);
  const { category, seedCategory, hyde } = categoryHyde(query, clauses);
  const rewrittenDeonticQuery = `DEONTIC_SEARCH(query="${query}", category=${category}, modalities=[OBLIGATION, PROHIBITION], targets=[SQL DDL, Python AST, TypeScript AST, Z3 proofs])`;
  const queryText = `${query} ${hyde}`;

  // Dense
  const qVec = computeSemanticEmbedding(queryText);
  const dense = new Map<string, number>();
  for (const c of chunks) {
    // With store-backed vectors, a chunk that has none (its embedding failed) gets no dense
    // score; mixing in a feature-hashing cosine would compare scores from two vector spaces.
    dense.set(c.chunkId, options.denseScores ? (options.denseScores.get(c.chunkId) ?? 0) : cosineSimilarity(qVec, computeSemanticEmbedding(c.contextualizedText)));
  }

  // BM25 (k1 = 1.5, b = 0.75) with document frequencies over token sets
  const docs = chunks.map((c) => bm25Tokens(c.contextualizedText));
  const docSets = docs.map((d) => new Set(d));
  const avgDl = docs.reduce((acc, d) => acc + d.length, 0) / Math.max(1, docs.length);
  const queryTokens = [...new Set(bm25Tokens(queryText))];
  const bm25Raw = docs.map((d, idx) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const df = docSets.filter((s) => s.has(q)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((f * 2.5) / (f + 1.5 * (1 - 0.75 + 0.75 * (d.length / avgDl))));
    }
    void idx;
    return score;
  });
  const bm25Max = Math.max(1e-9, ...bm25Raw);

  // Graph
  const { chunkDistance, reachedTriples } = options.entityDistances
    ? chunkDistancesFrom(options.entityDistances, chunks, triples)
    : graphDistances(query, seedCategory, clauses, chunks, triples);

  // Reciprocal Rank Fusion over the three rankings (k = 60)
  const rankOf = (scores: number[]) => {
    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
    const rank = new Array<number>(scores.length);
    order.forEach((o, r) => (rank[o.i] = o.s > 0 ? r + 1 : Infinity));
    return rank;
  };
  const denseArr = chunks.map((c) => dense.get(c.chunkId) || 0);
  const graphArr = chunks.map((c) => (chunkDistance.has(c.chunkId) ? 1 / (1 + chunkDistance.get(c.chunkId)!) : 0));
  const ranks = [rankOf(denseArr), rankOf(bm25Raw), rankOf(graphArr)];
  const rrf = chunks.map((_, i) => ranks.reduce((acc, r) => acc + (Number.isFinite(r[i]) ? 1 / (60 + r[i]) : 0), 0));
  const rrfMax = Math.max(1e-9, ...rrf);

  const round = (v: number) => Math.round(v * 1000) / 1000;
  const scored: RagRetrievedItem[] = chunks.map((chunk, i) => ({
    chunk,
    denseVectorScore: round(denseArr[i]),
    bm25KeywordScore: round(bm25Raw[i] / bm25Max),
    graphTraversalBoost: round(graphArr[i]),
    rrfHybridScore: round(rrf[i] / rrfMax),
    crossEncoderRerankScore: round(options.rerankScores?.get(chunk.chunkId) ?? rrf[i] / rrfMax),
    cragVerdict: bm25Raw[i] > 0 || denseArr[i] >= 0.25 ? 'CORRECT_HIGH_CONFIDENCE' : 'AMBIGUOUS_REFINED',
  }));
  scored.sort((a, b) => b.rrfHybridScore - a.rrfHybridScore);
  if (options.rerankScores) scored.sort((a, b) => b.crossEncoderRerankScore - a.crossEncoderRerankScore);
  const topRetrieved = scored.slice(0, topK);

  // Grounded answer built only from retrieved chunks and Z3 results
  const violated = proofs.filter((p) => p.status === 'UNSAT_VIOLATION' && (p.category === category || topRetrieved.some((r) => r.chunk.sourceId === `proof:${p.clauseId}`)));
  const citations = topRetrieved.map((r) => r.chunk.citationOrPath);
  const locations = violated.flatMap((p) => p.offendingLocations.map((l) => `${l.filePath}:${l.line}`));
  const synthesizedNeuroSymbolicAnswer =
    violated.length > 0
      ? `[Grounded in ${citations.join(', ')}]: Z3 refutes ${violated.map((p) => `${p.citation} (core: ${p.unsatCoreAssertions.slice(0, 3).join(', ')})`).join('; ')}. Offending code: ${locations.join(', ') || 'see proofs'}.`
      : `[Grounded in ${citations.join(', ')}]: Z3 proves the ${category} clauses SAT_COMPLIANT for the scanned constructs.`;

  // Retrieval metrics against category-derived relevance labels
  const relevant = chunks.filter((c) => isRelevant(c, category, clauses, proofs));
  const relevantIds = new Set(relevant.map((c) => c.chunkId));
  const hits = topRetrieved.filter((r) => relevantIds.has(r.chunk.chunkId)).length;
  let apSum = 0;
  let seen = 0;
  topRetrieved.forEach((r, idx) => {
    if (relevantIds.has(r.chunk.chunkId)) {
      seen++;
      apSum += seen / (idx + 1);
    }
  });
  const contextPrecision = topRetrieved.length ? apSum / Math.max(1, Math.min(topK, relevant.length)) : 0;
  const contextRecall = relevant.length ? hits / relevant.length : 1;
  const retrievedText = topRetrieved.map((r) => `${r.chunk.citationOrPath} ${r.chunk.contextualizedText}`).join('\n');
  const claims = [...citations, ...locations, ...violated.map((p) => p.citation)];
  const faithfulness = claims.length ? claims.filter((c) => retrievedText.includes(c.replace(/:\d+$/, ''))).length / claims.length : 1;
  const answerRelevance = Math.max(0, cosineSimilarity(computeSemanticEmbedding(query), computeSemanticEmbedding(synthesizedNeuroSymbolicAnswer)));
  const deonticAlignmentScore = topRetrieved.length ? hits / topRetrieved.length : 0;
  const metrics = [contextPrecision, contextRecall, faithfulness, answerRelevance, deonticAlignmentScore].map((v) => round(Math.min(1, v)));

  return {
    queryId: `RAG-${Date.now().toString(36)}`,
    originalQuery: query,
    hydeHypotheticalFormalQuery: hyde,
    rewrittenDeonticQuery,
    // Only the steps that ran on this query, named for what they do here.
    techniquesExecuted: [
      'Chunks per clause, SQL table, code construct and Z3 proof, each with a template prefix naming its source',
      `Query expanded with the matching clause's SMT text (category ${category})`,
      `Dense retrieval: ${options.denseBackend || '384-d feature hashing'}`,
      'BM25 keyword search (k1 = 1.5, b = 0.75)',
      `Graph walk, up to 2 hops: ${options.graphDbBackend || 'in-memory graph'}`,
      'Reciprocal rank fusion of the three rankings (k = 60)',
      ...(options.rerankBackend ? [`Cross-encoder rerank: ${options.rerankBackend}`] : []),
      'Confidence label per chunk: a BM25 hit or cosine ≥ 0.25',
    ],
    latencyMs: Math.max(0.1, Math.round((performance.now() - t0) * 100) / 100),
    retrievedChunks: topRetrieved,
    matchedGraphTriples: reachedTriples.slice(0, 12),
    synthesizedNeuroSymbolicAnswer,
    ragasMetrics: {
      contextPrecision: metrics[0],
      contextRecall: metrics[1],
      faithfulness: metrics[2],
      answerRelevance: metrics[3],
      deonticAlignmentScore: metrics[4],
      overallRagasScore: round(metrics.reduce((a, b) => a + b, 0) / metrics.length),
      evaluationMethod: `Computed against category-derived relevance labels (${relevant.length} relevant chunks for ${category}); dense backend: ${options.denseBackend || '384-d feature hashing'}; reranker: ${options.rerankBackend || 'RRF order (no cross-encoder loaded)'}`,
    },
    vectorDbBackend: options.vectorDbBackend || 'in-memory cosine over 384-d feature-hashed vectors',
    graphDbBackend: options.graphDbBackend || 'in-memory adjacency graph (breadth-first, 2 hops)',
  };
}

/**
 * Executes the full 7-Stage Hybrid Contextual + Graph RAG Pipeline:
 * 1. Query Rewriting & Deontic Entity Extraction
 * 2. HyDE (Hypothetical Formal SMT + AST Document Expansion)
 * 3. Dense Vector Cosine Search
 * 4. BM25 Sparse Keyword Search
 * 5. Knowledge Graph 2-Hop Traversal Boost (Graph RAG)
 * 6. Reciprocal Rank Fusion (RRF)
 * 7. Corrective RAG (CRAG) Verdicts + Retrieval Metrics
 */
export function executeHybridRagQuery(
  query: string,
  clauses: LegalClause[],
  sqlTables: SQLTableSchema[],
  astFindings: ASTFindingNode[],
  proofs: ClauseVerificationProof[],
  topK = 5
): RagQueryExecutionReport {
  return hybridRetrieve(query, clauses, sqlTables, astFindings, proofs, topK);
}

/** Cross-encoder scorer: relevance of each passage to the query (higher is better). */
export type CrossEncoder = { name: string; score(query: string, passages: string[]): Promise<number[]> };

/**
 * The pipeline backed by real stores: chunk vectors are synced to pgvector and ranked by
 * its HNSW cosine index; the entity graph is loaded into the graph store (Neo4j when
 * configured) and traversed there; an optional cross-encoder reranks the fused list.
 */
export async function executeStoreBackedRagQuery(
  query: string,
  clauses: LegalClause[],
  sqlTables: SQLTableSchema[],
  astFindings: ASTFindingNode[],
  proofs: ClauseVerificationProof[],
  topK = 5,
  deps: {
    embed?: (text: string) => Promise<{ embedding: number[]; model: string }>;
    vectorStore?: VectorStore;
    graphStore?: GraphStore;
    crossEncoder?: CrossEncoder | null;
  } = {}
): Promise<RagQueryExecutionReport> {
  const t0 = performance.now();
  const { chunks, triples } = buildContextualRagCorpus(clauses, sqlTables, astFindings, proofs);
  const { seedCategory, hyde } = categoryHyde(query, clauses);
  const hashing = async (text: string) => ({ embedding: computeSemanticEmbedding(text), model: '384-d feature hashing' });
  let embed = deps.embed || hashing;

  let queryVec = await embed(`${query} ${hyde}`);
  if (queryVec.embedding.length === 0) {
    // The embedding model stopped answering before the query was embedded: rank with hashing.
    embed = hashing;
    queryVec = await embed(`${query} ${hyde}`);
  }
  const records = [];
  let unembedded = 0;
  for (const c of chunks) {
    const e = await embed(c.contextualizedText);
    // A chunk the model could not embed keeps its BM25 and graph scores; only its dense score is lost.
    if (e.embedding.length !== queryVec.embedding.length) {
      unembedded++;
      continue;
    }
    records.push({ id: c.chunkId, text: c.contextualizedText, embedding: e.embedding });
  }
  const vectorStore = deps.vectorStore || (await getVectorStore(queryVec.model, queryVec.embedding.length));
  await vectorStore.sync(records);
  const denseScores = await vectorStore.search(queryVec.embedding, chunks.length);

  const graphStore = deps.graphStore || (await getGraphStore());
  await graphStore.load(triples);
  // Entities linked only from chunks are not graph edges but can still be named by the query.
  const known = new Set([...(await graphStore.entities()), ...chunks.flatMap((c) => c.linkedGraphEntities.map((e) => e.toLowerCase()))]);
  const seeds = graphSeeds(query, seedCategory, clauses, known);
  const entityDistances = await graphStore.distancesFrom(seeds, 2);

  const options: RetrievalOptions = {
    denseScores,
    denseBackend: unembedded > 0 ? `${queryVec.model}; ${unembedded} of ${chunks.length} chunks not embedded` : queryVec.model,
    vectorDbBackend: vectorStore.backend,
    entityDistances,
    graphDbBackend: graphStore.backend,
  };
  const crossEncoder = deps.crossEncoder === undefined ? await getCrossEncoder() : deps.crossEncoder;
  if (crossEncoder) {
    // Rerank the fused candidates (2 × topK) with the cross-encoder.
    const fused = hybridRetrieve(query, clauses, sqlTables, astFindings, proofs, Math.min(chunks.length, topK * 2), options);
    const scores = await crossEncoder.score(query, fused.retrievedChunks.map((r) => r.chunk.contextualizedText));
    options.rerankScores = new Map(fused.retrievedChunks.map((r, i) => [r.chunk.chunkId, scores[i]]));
    for (const c of chunks) if (!options.rerankScores.has(c.chunkId)) options.rerankScores.set(c.chunkId, -Infinity);
    options.rerankBackend = crossEncoder.name;
  }
  const report = hybridRetrieve(query, clauses, sqlTables, astFindings, proofs, topK, options);
  return { ...report, latencyMs: Math.round((performance.now() - t0) * 10) / 10 };
}

/**
 * Store-backed retrieval with neural dense vectors when the Ollama embedding model answers
 * (LEXCOMPILER_EMBEDDING_MODEL, default all-minilm), otherwise 384-d feature hashing. The
 * HTTP endpoint and the MCP tool both use this, so they rank the same way.
 */
export async function executeNeuralRetrieval(
  query: string,
  clauses: LegalClause[],
  sqlTables: SQLTableSchema[],
  astFindings: ASTFindingNode[],
  proofs: ClauseVerificationProof[],
  topK = 5
): Promise<RagQueryExecutionReport> {
  const probe = await computeRealNeuralEmbedding(query);
  const embed =
    probe.embedding.length > 0
      ? async (text: string) => {
          const e = await computeRealNeuralEmbedding(text);
          return { embedding: e.embedding, model: probe.modelUsed };
        }
      : undefined;
  return executeStoreBackedRagQuery(query, clauses, sqlTables, astFindings, proofs, topK, { embed });
}

/** Neural retrieval, then a local LLM writes a short grounded answer. */
export async function executeRealNeuralRagQuery(
  query: string,
  clauses: LegalClause[],
  sqlTables: SQLTableSchema[],
  astFindings: ASTFindingNode[],
  proofs: ClauseVerificationProof[],
  topK = 5
): Promise<RagQueryExecutionReport> {
  const t0 = performance.now();
  const report = await executeNeuralRetrieval(query, clauses, sqlTables, astFindings, proofs, topK);

  const contextBlock = report.retrievedChunks
    .slice(0, 3)
    .map((c) => `[${c.chunk.citationOrPath}]: ${c.chunk.rawChunkText.slice(0, 220)}`)
    .join('\n');
  const llmGen = await runRealLlmInference({
    prompt: `Question: ${query}\nRetrieved Context:\n${contextBlock}\nProvide a concise 2-sentence grounded compliance answer citing the exact file/statute:`,
    maxTokens: 95,
    task: 'rag-answer',
  });

  return {
    ...report,
    latencyMs: Math.round((performance.now() - t0) * 10) / 10,
    synthesizedNeuroSymbolicAnswer: llmGen.available
      ? `[${llmGen.model}]: ${llmGen.responseText} — ${report.synthesizedNeuroSymbolicAnswer}`
      : report.synthesizedNeuroSymbolicAnswer,
  };
}
