import { performance } from 'node:perf_hooks';
import { analyzeFullRepositoryAsync } from '../analyzer/astAnalyzer.js';
import { runTreeSitterQueries } from '../analyzer/treeSitter.js';
import { readTargetRepoFiles } from '../analyzer/repoBaseline.js';
import {
  compileLegalProseToFormalPolicy,
  fetchLiveRegulatoryFeed,
  getInitialClauses,
  inferRuleCategoryFromProse,
  sha256Hex,
} from '../compiler/legalCompiler.js';
import { RULE_CATEGORIES } from '../product/clauses.js';
import { verifyRepositoryAgainstClauses } from '../prover/z3Engine.js';
import { executeNeuralRetrieval } from '../rag/hybridRagEngine.js';
import { synthesizeRemediationPullRequest } from '../remediation/prSynthesizer.js';
import type {
  LegalClause,
  McpServerDescriptor,
  McpToolInvocationResult,
  RuleCategory,
  TargetRepoFile,
} from '../../shared/types.js';

type McpServerSpec = Omit<McpServerDescriptor, 'toolsCount' | 'resourcesCount' | 'promptsCount'>;

/** The six built-in servers. Counts are derived from what each server actually exposes. */
export function getMcpServersCatalog(): McpServerDescriptor[] {
  const servers: McpServerSpec[] = [
    {
      id: 'lex-statute-ingest-mcp',
      name: 'LexStatute Ingest & Horizon Scanner MCP',
      role: 'BUILT_CUSTOM',
      version: '2.4.0',
      transports: ['stdio', 'streamable-http'],
      endpointUrl: '/api/mcp/lex-statute-ingest-mcp/rpc',
      stdioCommand: 'npx tsx server/mcp/stdio-server.ts lex-statute-ingest-mcp',
      status: 'ONLINE',
      description:
        'Custom MCP server for scraping EUR-Lex CELEX statutes, querying the live U.S. Federal Register REST API, parsing enterprise DPA PDFs/XML/JSON, and normalizing legal clauses.',
      tools: [
        {
          name: 'fetch_live_regulatory_feed',
          description: 'Fetches real-time statutory updates from EUR-Lex and the U.S. Federal Register API.',
          inputSchema: {
            type: 'object',
            properties: {
              jurisdiction: { type: 'string', enum: ['ALL', 'EU', 'US'] },
            },
          },
          sampleArgs: { jurisdiction: 'ALL' },
        },
        {
          name: 'parse_dpa_contract_clause',
          description: 'Extracts normative obligations and temporal bounds from raw contractual prose.',
          inputSchema: {
            type: 'object',
            properties: {
              clauseText: { type: 'string' },
              framework: { type: 'string' },
            },
            required: ['clauseText'],
          },
          sampleArgs: {
            clauseText:
              'PII must be encrypted at rest with tenant-isolated keys and purged within 72 hours.',
            framework: 'ENTERPRISE_DPA',
          },
        },
      ],
    },
    {
      id: 'lex-deontic-compiler-mcp',
      name: 'LexDeontic Neuro-Symbolic Compiler MCP',
      role: 'BUILT_CUSTOM',
      version: '2.4.0',
      transports: ['stdio', 'streamable-http'],
      endpointUrl: '/api/mcp/lex-deontic-compiler-mcp/rpc',
      stdioCommand: 'npx tsx server/mcp/stdio-server.ts lex-deontic-compiler-mcp',
      status: 'ONLINE',
      description:
        'Compiles natural-language legal obligations O(φ), prohibitions F(φ), and permissions P(φ) into First-Order Logic, Microsoft Z3 SMT-LIB2 scripts, and OPA Rego policies.',
      tools: [
        {
          name: 'compile_prose_to_smt_and_rego',
          description: 'Compiles legal prose directly into SMT-LIB2 assertions, OPA Rego rules, and AST queries.',
          inputSchema: {
            type: 'object',
            properties: {
              rawLegalText: { type: 'string' },
              // An unknown category used to fall through to another category's template; now it is rejected.
              category: { type: 'string', enum: RULE_CATEGORIES, description: 'Leave out to infer the category from the text.' },
              citation: { type: 'string' },
            },
            required: ['rawLegalText'],
          },
          sampleArgs: {
            rawLegalText:
              'All PII must be encrypted at rest with tenant-isolated keys and purged within 72 hours.',
            category: 'RETENTION_AND_TENANT_KMS',
            citation: 'GDPR Art. 17 & 32 / DPA §4.2',
          },
        },
      ],
    },
    {
      id: 'lex-polyglot-ast-mcp',
      name: 'LexAST Polyglot Code & SQL Schema Mapper MCP',
      role: 'BUILT_CUSTOM',
      version: '2.4.0',
      transports: ['stdio', 'streamable-http'],
      endpointUrl: '/api/mcp/lex-polyglot-ast-mcp/rpc',
      stdioCommand: 'npx tsx server/mcp/stdio-server.ts lex-polyglot-ast-mcp',
      status: 'ONLINE',
      description:
        'Parses live Python 3 ASTs, TypeScript Compiler ASTs, and PostgreSQL DDL schemas into a unified Compliance Intermediate Representation & Data-Flow Knowledge Graph.',
      tools: [
        {
          name: 'scan_polyglot_repository_ast',
          description: 'Parses SQL DDL, Python 3 AST, and TypeScript AST files in target-repo/ and extracts PII data-flow facts.',
          inputSchema: {
            type: 'object',
            properties: {
              includeMetrics: { type: 'boolean' },
            },
          },
          sampleArgs: { includeMetrics: true },
        },
      ],
    },
    {
      id: 'lex-z3-prover-mcp',
      name: 'LexZ3 Formal Theorem Prover & Attestation MCP',
      role: 'BUILT_CUSTOM',
      version: '2.4.0',
      transports: ['stdio', 'streamable-http'],
      endpointUrl: '/api/mcp/lex-z3-prover-mcp/rpc',
      stdioCommand: 'npx tsx server/mcp/stdio-server.ts lex-z3-prover-mcp',
      status: 'ONLINE',
      description:
        'Executes the Microsoft Z3 SMT Solver over compiled statutory axioms and AST facts, extracting minimal UNSAT Cores, Counterexample Witnesses, and SHA-256 Merkle Provenance proofs.',
      tools: [
        {
          name: 'prove_repository_compliance_z3',
          description: 'Runs Microsoft Z3 SMT check-sat across all active statutory clauses and returns formal proofs.',
          inputSchema: {
            type: 'object',
            properties: {
              extractUnsatCore: { type: 'boolean' },
            },
          },
          sampleArgs: { extractUnsatCore: true },
        },
      ],
    },
    {
      id: 'lex-hybrid-rag-mcp',
      name: 'LexRAG Contextual + Graph RAG & CRAG MCP',
      role: 'BUILT_CUSTOM',
      version: '2.4.0',
      transports: ['stdio', 'streamable-http'],
      endpointUrl: '/api/mcp/lex-hybrid-rag-mcp/rpc',
      stdioCommand: 'npx tsx server/mcp/stdio-server.ts lex-hybrid-rag-mcp',
      status: 'ONLINE',
      description:
        'Exposes Anthropic-style Contextual RAG, Semantic/Late Chunking, pgvector + BM25 RRF Hybrid Search, Neo4j Knowledge Graph traversal, HyDE query expansion, and RAGAS telemetry.',
      tools: [
        {
          name: 'hybrid_contextual_graph_rag_query',
          description: 'Executes HyDE + Contextual RAG + BM25/Vector RRF + 2-Hop Knowledge Graph retrieval with RAGAS scoring.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              topK: { type: 'number' },
            },
            required: ['query'],
          },
          sampleArgs: {
            query:
              'Which SQL tables and Python endpoints violate the 72-hour retention and tenant-isolated KMS requirement?',
            topK: 4,
          },
        },
      ],
    },
    {
      id: 'lex-remediation-pr-mcp',
      name: 'LexPR Autonomous Patch Synthesizer & n8n Enforcer MCP',
      role: 'BUILT_CUSTOM',
      version: '2.4.0',
      transports: ['stdio', 'streamable-http'],
      endpointUrl: '/api/mcp/lex-remediation-pr-mcp/rpc',
      stdioCommand: 'npx tsx server/mcp/stdio-server.ts lex-remediation-pr-mcp',
      status: 'ONLINE',
      description:
        'Synthesizes drop-in AST/SQL diffs for UNSAT violations, executes a Pre-PR Z3 Sandbox Verification Gate, opens automated remediation PRs, and triggers n8n/Slack compliance webhooks.',
      tools: [
        {
          name: 'synthesize_and_verify_remediation_pr',
          description: 'Generates multi-file unified diffs and verifies post-patch SAT compliance in Z3 sandbox.',
          inputSchema: {
            type: 'object',
            properties: {
              branchPrefix: { type: 'string' },
            },
          },
          sampleArgs: { branchPrefix: 'lexcompiler/auto-remediate' },
        },
      ],
    },
  ];
  return servers.map((server) => ({
    ...server,
    toolsCount: server.tools.length,
    resourcesCount: resourcesFor(server.id).length,
    // No server implements prompts/list, so none are advertised.
    promptsCount: 0,
  }));
}

/** MCP protocol revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

/** JSON-RPC error with an MCP/JSON-RPC error code. */
export class McpError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
  }
}

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): void {
  const properties = (schema.properties || {}) as Record<string, { type?: string; enum?: unknown[] }>;
  for (const key of (schema.required as string[] | undefined) || []) {
    if (args[key] === undefined) throw new McpError(-32602, `Missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec || value === undefined) continue;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const expected = spec.type === 'integer' ? 'number' : spec.type;
    if (expected && actual !== expected) {
      throw new McpError(-32602, `Argument "${key}" must be ${spec.type}, got ${actual}`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new McpError(-32602, `Argument "${key}" must be one of ${spec.enum.join(', ')}`);
    }
  }
}

/**
 * Runs one tool; throws McpError(-32602) for unknown servers, tools, or invalid arguments.
 * `files` is the repository the tools read (default: the bundled target repository).
 */
export async function executeMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  clauses: LegalClause[],
  files?: TargetRepoFile[]
): Promise<Record<string, unknown>> {
  const server = getMcpServersCatalog().find((s) => s.id === serverId);
  if (!server) throw new McpError(-32602, `Unknown MCP server "${serverId}"`);
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) throw new McpError(-32602, `Unknown tool "${toolName}" on ${serverId}`);
  validateArguments(tool.inputSchema, args);

  const repo = () => analyzeFullRepositoryAsync(files ?? readTargetRepoFiles());
  switch (toolName) {
    case 'fetch_live_regulatory_feed': {
      const feed = await fetchLiveRegulatoryFeed();
      const jurisdiction = String(args.jurisdiction || 'ALL');
      const items = feed.filter(
        (i) => jurisdiction === 'ALL' || (jurisdiction === 'EU' ? i.source === 'EUR_LEX' : i.source === 'FEDERAL_REGISTER')
      );
      return { totalStatutesFetched: items.length, items };
    }
    case 'parse_dpa_contract_clause': {
      const text = String(args.clauseText);
      const category = inferRuleCategoryFromProse(text);
      const compiled = compileLegalProseToFormalPolicy(text, category, 'CLAUSE-MCP-INGEST', String(args.framework || 'Custom DPA'));
      return { inferredCategory: category, extractedDeontic: compiled.deontic, statuteSha256: sha256Hex(text) };
    }
    case 'compile_prose_to_smt_and_rego': {
      const text = String(args.rawLegalText);
      const category = (args.category as RuleCategory) || inferRuleCategoryFromProse(text);
      return { ...compileLegalProseToFormalPolicy(text, category, 'CLAUSE-MCP-COMPILE', String(args.citation || 'Custom clause')) };
    }
    case 'scan_polyglot_repository_ast': {
      const { sqlTables, astFindings, enrichedFiles } = await repo();
      const structuralQueryMatches: Record<string, unknown> = {};
      for (const clause of clauses) {
        structuralQueryMatches[clause.id] = await runTreeSitterQueries(clause.compiled.astPatternQuery, enrichedFiles);
      }
      return {
        structuralQueryMatches,
        filesScanned: enrichedFiles.length,
        totalAstNodes: enrichedFiles.reduce((acc, f) => acc + (f.astNodeCount || 0), 0),
        sqlTables,
        astFindings,
      };
    }
    case 'prove_repository_compliance_z3': {
      const { sqlTables, astFindings } = await repo();
      const verification = await verifyRepositoryAgainstClauses(clauses, sqlTables, astFindings);
      return {
        totalSolveTimeMs: verification.totalZ3ExecutionMs,
        merkleAuditRoot: verification.merkleAuditRoot,
        verdicts: verification.proofs.map((p) => ({
          clauseId: p.clauseId,
          citation: p.citation,
          status: p.status,
          unsatCore: p.unsatCoreAssertions,
          offendingLocations: p.offendingLocations.map((l) => ({ filePath: l.filePath, line: l.line, explanation: l.explanation })),
          reviewReasons: p.reviewReasons || [],
          solveTimeMs: p.z3SolveTimeMs,
        })),
      };
    }
    case 'hybrid_contextual_graph_rag_query': {
      const { sqlTables, astFindings } = await repo();
      const verification = await verifyRepositoryAgainstClauses(clauses, sqlTables, astFindings);
      const topK = typeof args.topK === 'number' ? args.topK : 4;
      return { ...(await executeNeuralRetrieval(String(args.query), clauses, sqlTables, astFindings, verification.proofs, topK)) };
    }
    case 'synthesize_and_verify_remediation_pr': {
      const { sqlTables, astFindings, enrichedFiles } = await repo();
      const verification = await verifyRepositoryAgainstClauses(clauses, sqlTables, astFindings);
      const pr = await synthesizeRemediationPullRequest(clauses, enrichedFiles, verification.proofs);
      return pr ? { ...pr } : { status: 'ALL_COMPLIANT_NO_PR_NEEDED', merkleAuditRoot: verification.merkleAuditRoot };
    }
    default:
      throw new McpError(-32602, `Tool "${toolName}" has no implementation`);
  }
}

function resourcesFor(serverId: string) {
  return [
    { uri: `lex://${serverId}/clauses/active`, name: 'Active legal clauses', mimeType: 'application/json' },
    { uri: `lex://${serverId}/repository/files`, name: 'Scanned repository files', mimeType: 'application/json' },
    { uri: `lex://${serverId}/proofs/latest`, name: 'Latest Z3 verdicts', mimeType: 'application/json' },
  ];
}

async function readResource(serverId: string, uri: string, clauses: LegalClause[]): Promise<unknown> {
  if (uri === `lex://${serverId}/clauses/active`) return clauses;
  if (uri === `lex://${serverId}/repository/files`) {
    return readTargetRepoFiles().map((f) => ({ path: f.path, language: f.language, bytes: f.content.length }));
  }
  if (uri === `lex://${serverId}/proofs/latest`) {
    const { sqlTables, astFindings } = await analyzeFullRepositoryAsync(readTargetRepoFiles());
    const v = await verifyRepositoryAgainstClauses(clauses, sqlTables, astFindings);
    return v.proofs.map((p) => ({ clauseId: p.clauseId, status: p.status, unsatCore: p.unsatCoreAssertions }));
  }
  throw new McpError(-32002, `Resource not found: ${uri}`);
}

/**
 * Handles one MCP JSON-RPC 2.0 message (Streamable HTTP POST body or stdio line).
 * Returns the response, or null for notifications.
 */
export async function handleMcpMessage(
  serverId: string,
  message: unknown,
  clauses: LegalClause[],
  /** The repository tools/call reads (default: the bundled target repository). */
  files?: TargetRepoFile[]
): Promise<JsonRpcResponse | null> {
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const hasId = msg && typeof msg === 'object' && 'id' in msg && (typeof msg.id === 'string' || typeof msg.id === 'number');
  const id: JsonRpcId = hasId ? (msg.id as string | number) : null;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (!hasId) return null; // notifications (initialized, cancelled, …) get no response

  const server = getMcpServersCatalog().find((s) => s.id === serverId);
  if (!server) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown MCP server "${serverId}"` } };
  const params = msg.params || {};

  try {
    switch (msg.method) {
      case 'initialize': {
        const requested = String(params.protocolVersion || '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: { name: server.name, version: server.version },
            instructions: server.description,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: server.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
        };
      case 'tools/call': {
        if (typeof params.name !== 'string') throw new McpError(-32602, 'params.name must be a string');
        const args = (params.arguments as Record<string, unknown> | undefined) || {};
        try {
          const output = await executeMcpTool(serverId, params.name, args, clauses, files);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output, isError: false },
          };
        } catch (err) {
          if (err instanceof McpError) throw err;
          // Tool execution failures are reported in-band so the model can see them.
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true },
          };
        }
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: resourcesFor(serverId) } };
      case 'resources/read': {
        const uri = String(params.uri || '');
        const data = await readResource(serverId, uri, clauses);
        return {
          jsonrpc: '2.0',
          id,
          result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] },
        };
      }
      default:
        throw new McpError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    if (err instanceof McpError) {
      return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Runs a tools/call through the JSON-RPC handler and returns a request/response trace for the UI. */
export async function invokeMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  activeClauses?: LegalClause[]
): Promise<McpToolInvocationResult> {
  const t0 = performance.now();
  const rpcId = `rpc-${Date.now().toString(36)}`;
  const request = { jsonrpc: '2.0' as const, id: rpcId, method: 'tools/call' as const, params: { name: toolName, arguments: args } };
  const response = await handleMcpMessage(serverId, request, activeClauses || getInitialClauses());
  return {
    invocationId: `MCP-CALL-${rpcId}`,
    serverId,
    toolName,
    transportUsed: 'streamable-http',
    latencyMs: Math.round((performance.now() - t0) * 100) / 100,
    jsonRpcRequest: request,
    jsonRpcResponse: response as McpToolInvocationResult['jsonRpcResponse'],
    timestamp: new Date().toISOString(),
  };
}
