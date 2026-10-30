import crypto from 'node:crypto';
import { externalClient, probeExternalMcpServers } from './mcp/externalClients.js';
import { getAttestationSigner, revocations, revoke, trustedKeys } from './enterprise/attestationSigner.js';
import { verifyTimestamp } from './enterprise/timestamp.js';
import { OidcProvider, oidcConfigFromEnv } from './auth/oidc.js';
import { getDb } from './db/index.js';
import { createAuthenticator, createProductRouter } from './product/router.js';
import { databaseSessionStore, ProductStore } from './product/store.js';
import { GovernanceStore } from './product/governance.js';
import { EvidenceLog } from './evidence/log.js';
import { expireExceptions, recordScanEvidence, requestFromCheckRun, ruleDecided, type FlowDeps } from './product/flows.js';
import { mountWorkspaceRoutes } from './product/workspaceRoutes.js';
import { createPublicRoutes } from './product/publicRoutes.js';
import { createWorkspaceMcpHandler } from './mcp/workspaceMcp.js';
import { createGovernanceJobHandlers } from './github/governanceJobs.js';
import { getAiGateway } from './ai/gateway.js';
import { lexcompilerVersion } from './util/versions.js';
import { GitHubApp, githubUrls } from './github/client.js';
import { loadGitHubAppCredentials } from './github/credentials.js';
import { createBrowserAuth, createGitHubApiRouter, createGitHubRoutes } from './github/routes.js';
import { createScanJobHandler } from './github/scanJob.js';
import { createWebhookHandler } from './github/webhooks.js';
import { JobQueue } from './jobs/queue.js';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import {
  buildMultiAgentExecutionReport,
  getPromptLibraryCatalog,
} from './agents/multiAgentOrchestrator.js';
import { analyzeFullRepositoryAsync } from './analyzer/astAnalyzer.js';
import {
  ensureTargetRepoFilesExist,
  readTargetRepoFiles,
  resetTargetRepoToBaseline,
  TARGET_REPO_IS_FIXTURE,
  TARGET_REPO_ROOT,
  TargetRepoPathError,
  writeTargetRepoFile,
} from './analyzer/repoBaseline.js';
import {
  compileLegalProseToFormalPolicyAsync,
  fetchLiveRegulatoryFeed,
  getBanglaInitialClauses,
  getInitialClauses,
  getMutationPresets,
  FRAMEWORK_DISPLAY_NAMES,
  inferRuleCategoryFromProse,
} from './compiler/legalCompiler.js';
import { getMcpServersCatalog, handleMcpMessage, invokeMcpTool } from './mcp/mcpSuite.js';
import { createAgentRouter } from './agents/routes.js';
import { loadActiveClauseState, saveActiveClauseState } from './state.js';
import {
  compressLegalProseCaveman,
  compressRepoToGraphifySExpr,
  countTokens,
  pruneCodeWithCodeburn,
  runTokenOptimizationBenchmarkAsync,
} from './optimization/tokenOptimizer.js';
import { verifyRepositoryAgainstClauses, z3SelfTest } from './prover/z3Engine.js';
import {
  executeStoreBackedRagQuery,
  executeRealNeuralRagQuery,
} from './rag/hybridRagEngine.js';
import { GitHubPrError, githubPrOptionsFromEnv, openGitHubPullRequest } from './remediation/githubPr.js';
import { synthesizeRemediationPullRequest } from './remediation/prSynthesizer.js';
import {
  commitTargetRepoChanges,
  ensureTargetRepoGitInitialized,
  executeRealWorldSandboxVerification,
  resetTargetRepoGitHistory,
  resolveRepositoryIdentity,
} from './sandbox/realWorldSandbox.js';
import {
  executeByocCustomScan,
  generateSarifReport,
  generateSignedConformityCertificate,
  verifyEd25519CertificateSignature,
} from './enterprise/enterpriseSuite.js';
import {
  computeRealNeuralEmbedding,
  ensurePersistentSqliteDb,
  getLiveServiceMeshTelemetry,
  runRealLlmInference,
} from './services/realAiServiceMesh.js';
import {
  assertSafeBindConfig,
  createApiGuard,
  isOriginAllowed,
  resolveServerSecurityConfig,
} from './security.js';
import { resolvePythonAsync } from './util/python.js';
import { buildComplianceReport } from './report.js';
import type {
  ComplianceFrameworkId,
  FullComplianceScanReport,
  LegalClause,
  RemediationPullRequest,
  RuleCategory,
} from '../shared/types.js';

/** Client errors (refused paths, non-fixture resets) are 400s; everything else is a 500. */
function sendError(res: express.Response, err: unknown): void {
  if (err instanceof TargetRepoPathError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

const securityConfig = resolveServerSecurityConfig();
assertSafeBindConfig(securityConfig);

const app = express();
// Behind a local reverse proxy or tunnel (cloudflared, Caddy), take the client address from X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(securityConfig, origin)),
  })
);
const oidcConfig = oidcConfigFromEnv();
const productStore = new ProductStore(getDb());

// GitHub App: credentials from the environment or data/github-app.json (written by /github/register).
const publicUrl = (process.env.LEXCOMPILER_PUBLIC_URL || `http://localhost:${securityConfig.port}`).replace(/\/+$/, '');
const ghUrls = githubUrls();
let githubApp: GitHubApp | null = null;
try {
  const credentials = loadGitHubAppCredentials();
  githubApp = credentials ? new GitHubApp(credentials, ghUrls) : null;
} catch (err) {
  console.error(`[github] ${err instanceof Error ? err.message : String(err)}`);
}
const getGitHubApp = () => githubApp;
const governance = new GovernanceStore(getDb());
const evidenceLog = new EvidenceLog(getDb());
const flowDeps: FlowDeps = { store: productStore, gov: governance, evidence: evidenceLog, queue: null, publicUrl };
const jobQueue: JobQueue = new JobQueue(
  getDb(),
  {
    scan: createScanJobHandler({
      store: productStore,
      getApp: getGitHubApp,
      publicUrl,
      gov: governance,
      recordEvidence: (scan, findings, checkRunUrl) => recordScanEvidence(flowDeps, scan, findings, { checkRunUrl }),
    }),
    ...createGovernanceJobHandlers({ store: productStore, getApp: getGitHubApp, queue: () => jobQueue }),
  },
  { onError: (err, job) => console.error(`[jobs] ${job.kind} ${job.id} attempt ${job.attempt} failed: ${err instanceof Error ? err.message : String(err)}`) }
);
flowDeps.queue = jobQueue;
// The webhook needs the raw body to check GitHub's signature, so it is registered before
// express.json() and the /api guard (GitHub sends no browser headers).
app.post('/api/github/webhooks', express.raw({ type: () => true, limit: '25mb' }), createWebhookHandler({ store: productStore, getApp: getGitHubApp, queue: jobQueue, relayReencoded: process.env.LEXCOMPILER_GITHUB_WEBHOOK_RELAY === 'smee', onRequestException: (input) => requestFromCheckRun(flowDeps, input) }));
app.use(express.json({ limit: '5mb' }));
// Auditor share pages and public keys: no account, the share token is the credential.
app.use(createPublicRoutes({ store: productStore, gov: governance, evidence: evidenceLog }));
// The workspace MCP server for coding assistants; personal access tokens, not cookies.
app.post('/mcp', createWorkspaceMcpHandler({ store: productStore, gov: governance, flows: flowDeps, getApp: getGitHubApp, allowedOrigins: securityConfig.allowedOrigins }));
app.all('/mcp', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Send MCP messages with POST; this server opens no event stream.' });
});
const oidcProvider = oidcConfig ? new OidcProvider(oidcConfig, databaseSessionStore(productStore)) : null;
// Expired sessions are also dropped when read; this keeps the table small.
productStore.purgeExpiredSessions();
setInterval(() => productStore.purgeExpiredSessions(), 60 * 60 * 1000).unref();
// Resolve the build id once at startup (one git call), not on the first scan request.
lexcompilerVersion();
const sessionStore = databaseSessionStore(productStore);
const signInRequired = Boolean(oidcProvider) || securityConfig.passwordSignIn;
app.use('/api', createApiGuard(securityConfig, signInRequired ? createAuthenticator(oidcProvider, securityConfig.apiToken, sessionStore) : undefined));
app.use(
  '/api',
  createProductRouter(productStore, oidcProvider, {
    reposRoot: process.env.LEXCOMPILER_PROJECT_REPOS_ROOT || path.join(process.cwd(), 'repos'),
    ai: getAiGateway(),
    passwordSignIn: securityConfig.passwordSignIn,
    onRuleDecided: (input) => ruleDecided(flowDeps, input),
    onScanCompleted: (scan, findings) => recordScanEvidence(flowDeps, scan, findings),
    extra: (r, helpers) =>
      mountWorkspaceRoutes(r, helpers, {
        store: productStore,
        gov: governance,
        evidence: evidenceLog,
        ai: getAiGateway(),
        flows: flowDeps,
        publicUrl,
        passwordSignIn: securityConfig.passwordSignIn,
        secureCookies: publicUrl.startsWith('https://'),
      }),
  })
);
// Approved exceptions past their date expire, and affected pull requests are re-checked.
const sweepExceptions = () => {
  try {
    expireExceptions(flowDeps);
  } catch (err) {
    console.error(`[exceptions] ${err instanceof Error ? err.message : String(err)}`);
  }
};
sweepExceptions();
setInterval(sweepExceptions, 10 * 60 * 1000).unref();
app.use('/api', createGitHubApiRouter(getGitHubApp));

/**
 * Requests that rewrite target-repo files, commit, or change clauses run one at a time,
 * so concurrent edits cannot interleave file writes and Git commits.
 */
let repoMutationQueue: Promise<void> = Promise.resolve();
function serializeRepoMutations(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  const previous = repoMutationQueue;
  let release!: () => void;
  repoMutationQueue = new Promise<void>((resolve) => (release = resolve));
  res.once('finish', () => release());
  res.once('close', () => release());
  previous.then(() => next());
}
app.post(
  [
    '/api/clauses/compile',
    '/api/clauses/mutate-preset',
    '/api/clauses/switch-locale',
    '/api/remediation/apply-node',
    '/api/remediation/apply-pr',
    '/api/repo/update-file',
    '/api/repo/reset',
  ],
  serializeRepoMutations
);

// Ensure real target repository files, Git repo & SQLite ledger exist on disk
ensureTargetRepoFilesExist();
// Off the event loop at startup; Git work is queued and Python is resolved once, before requests need them.
void ensureTargetRepoGitInitialized();
void resolvePythonAsync();
ensurePersistentSqliteDb();

const persistedState = loadActiveClauseState();
let activeClauses: LegalClause[] = persistedState?.clauses || getInitialClauses();
let activeAmendmentLabel: string | null =
  persistedState?.amendmentLabel ?? 'Amended DPA §4.2 / GDPR Art. 17: 72-Hour Purge + Tenant-Isolated KMS Keys';

/** Persists clause edits so they survive restarts and reach the stdio MCP server. */
function persistClauses(): void {
  saveActiveClauseState(activeClauses, activeAmendmentLabel);
}
let commitCounter = 1;

async function buildFullComplianceReport(
  options: { recordToLedger?: boolean } = {}
): Promise<FullComplianceScanReport> {
  return buildComplianceReport(activeClauses, activeAmendmentLabel, options);
}

async function checkPython3(): Promise<string | null> {
  return (await resolvePythonAsync())?.version ?? null;
}

/** Checks the dependencies scans need; 503 when Z3 or python3 is unavailable. */
app.get('/api/health', async (_req, res) => {
  const [z3, python, mcp] = await Promise.all([
    z3SelfTest(),
    checkPython3(),
    handleMcpMessage('lex-z3-prover-mcp', { jsonrpc: '2.0', id: 'health', method: 'ping' }, activeClauses),
  ]);
  let ledgerOk = true;
  try {
    ensurePersistentSqliteDb();
  } catch {
    ledgerOk = false;
  }
  const healthy = z3.ok && Boolean(python) && ledgerOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'LexCompiler Neuro-Symbolic Law-to-AST Engine',
    z3Solver: z3.ok ? 'ready' : `failed: ${z3.error || 'self-test'}`,
    z3SelfTestMs: z3.latencyMs,
    python3: python || 'unavailable',
    ledger: ledgerOk ? 'ready' : 'unavailable',
    mcpServersOnline: mcp?.result ? getMcpServersCatalog().length : 0,
    ragEngine: 'Contextual + Graph RAG + BM25/pgvector RRF + CRAG',
    astParsers: ['python3-ast', 'typescript-compiler-api', 'postgres-ddl-cst'],
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/state', async (_req, res) => {
  try {
    const report = await buildFullComplianceReport();
    res.json(report);
  } catch (err) {
    console.error('Error building compliance report:', err);
    sendError(res, err);
  }
});

app.get('/api/regulations/live-feed', async (_req, res) => {
  try {
    const items = await fetchLiveRegulatoryFeed();
    res.json({ items });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
// 6+ MCP SERVERS CONTROL PLANE (JSON-RPC 2.0 + SSE + STDIO)
// ============================================================================

/** External MCP servers: the suggested ones (NOT_CONFIGURED unless they answer) plus any in mcp-servers.json. */
async function externalMcpServerStatus() {
  // External servers count as integrated only when they answer initialize + tools/list.
  const live = await probeExternalMcpServers();
  const suggested = [
    {
      id: 'postgres-pgvector-mcp',
      name: 'PostgreSQL + pgvector Schema & Vector Store MCP',
      transport: 'stdio / sse',
      purpose: 'Live DDL introspection and HNSW vector similarity queries over statutory embeddings',
    },
    {
      id: 'neo4j-cypher-mcp',
      name: 'Neo4j Knowledge Graph & Blast-Radius Cypher MCP',
      transport: 'streamable-http',
      purpose: '2-hop Graph RAG traversal linking GDPR/HIPAA clauses to AST nodes and SQL columns',
    },
    {
      id: 'github-git-mcp',
      name: 'GitHub Repository & Pull Request Automation MCP',
      transport: 'streamable-http',
      purpose: 'Creates remediation branches, commits Z3-verified patches, and opens pull requests',
    },
    {
      id: 'filesystem-sandbox-mcp',
      name: 'Ephemeral Git Sandbox Filesystem MCP',
      transport: 'stdio',
      purpose: 'Reads and writes polyglot source files in isolated verification worktrees',
    },
    {
      id: 'duckdb-lakehouse-mcp',
      name: 'DuckDB / Apache Iceberg Compliance Ledger MCP',
      transport: 'stdio',
      purpose: 'Stores immutable Parquet/JSONL OpenLineage compliance telemetry and Z3 proof timings',
    },
    {
      id: 'n8n-webhook-bridge-mcp',
      name: 'n8n & Temporal Workflow Trigger MCP',
      transport: 'streamable-http / sse',
      purpose: 'Dispatches real-time regulatory shockwave alerts and CI/CD compliance gates',
    },
  ];
  return [
    ...suggested.map((e) => {
      const st = live.find((l) => l.id === e.id);
      return { ...e, status: st ? st.status : 'NOT_CONFIGURED', ...(st ? { liveTools: st.tools, serverInfo: st.serverInfo, error: st.error } : {}) };
    }),
    ...live.filter((l) => !suggested.some((e) => e.id === l.id)).map((l) => ({ id: l.id, name: l.serverInfo?.name || l.id, transport: l.transport, purpose: 'Configured in mcp-servers.json', status: l.status, liveTools: l.tools, serverInfo: l.serverInfo, error: l.error })),
  ];
}

app.get('/api/mcp/servers', async (_req, res) => {
  res.json({ servers: getMcpServersCatalog(), integratedExternalMcpServers: await externalMcpServerStatus() });
});

/** Calls a tool on a configured external MCP server. */
app.post('/api/mcp/external/:serverId/call', async (req, res) => {
  try {
    const client = await externalClient(String(req.params.serverId));
    res.json(await client.callTool(String(req.body?.name || ''), (req.body?.arguments as Record<string, unknown>) || {}));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** MCP Streamable HTTP transport: one JSON-RPC message per POST; notifications get 202. */
app.post('/api/mcp/:serverId/rpc', async (req, res) => {
  try {
    const { serverId } = req.params;
    if (!getMcpServersCatalog().some((s) => s.id === serverId)) {
      res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32602, message: `Unknown MCP server "${serverId}"` } });
      return;
    }
    const response = await handleMcpMessage(serverId, req.body, activeClauses);
    if (!response) {
      res.status(202).end();
      return;
    }
    res.json(response);
  } catch (err) {
    sendError(res, err);
  }
});

// The agent crew: the model route for the Python agents, and chained crew runs (server/agents/routes.ts).
app.use(createAgentRouter({ db: getDb(), gateway: getAiGateway, clauses: () => activeClauses }));

/** UI helper: runs tools/call and returns the full request/response trace. */
app.post('/api/mcp/:serverId/invoke', async (req, res) => {
  try {
    const { serverId } = req.params;
    const body = (req.body || {}) as { toolName?: string; arguments?: Record<string, unknown> };
    res.json(await invokeMcpTool(serverId, String(body.toolName || ''), body.arguments || {}, activeClauses));
  } catch (err) {
    sendError(res, err);
  }
});

/** This server does not offer a server-initiated SSE stream (allowed by Streamable HTTP). */
app.get('/api/mcp/:serverId/rpc', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Use POST for MCP JSON-RPC messages; no server-initiated SSE stream is offered.' });
});

// ============================================================================
// HYBRID CONTEXTUAL + GRAPH RAG ENGINE ENDPOINTS
// ============================================================================

app.post('/api/rag/query', async (req, res) => {
  try {
    const { query, topK } = (req.body || {}) as { query?: string; topK?: number };
    const q =
      query && query.trim()
        ? query.trim()
        : 'Which SQL tables and Python endpoints violate the 72-hour retention and tenant-isolated KMS requirement?';

    const rawFiles = readTargetRepoFiles();
    const { sqlTables, astFindings } = await analyzeFullRepositoryAsync(rawFiles);
    const verification = await verifyRepositoryAgainstClauses(
      activeClauses,
      sqlTables,
      astFindings
    );

    const ragReport = await executeRealNeuralRagQuery(
      q,
      activeClauses,
      sqlTables,
      astFindings,
      verification.proofs,
      topK || 5
    );
    res.json(ragReport);
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
// MULTI-AGENT ORCHESTRATOR & TOKEN OPTIMIZATION LAB ENDPOINTS
// ============================================================================

app.get('/api/ai-heavy/overview', async (req, res) => {
  try {
    const rawFiles = readTargetRepoFiles();
    const { sqlTables, astFindings, enrichedFiles } = await analyzeFullRepositoryAsync(rawFiles);
    const verification = await verifyRepositoryAgainstClauses(
      activeClauses,
      sqlTables,
      astFindings
    );
    const pr = await synthesizeRemediationPullRequest(
      activeClauses,
      enrichedFiles,
      verification.proofs
    );

    // Opening the engine console never spends model credit: the agents call their tools
    // directly unless ?agentModels=1 asks for the configured models (still budget-capped).
    const multiAgentReport = await buildMultiAgentExecutionReport(
      activeClauses,
      enrichedFiles,
      sqlTables,
      astFindings,
      verification.proofs,
      pr,
      { useModels: req.query.agentModels === '1' }
    );

    const tokenBenchmark = await runTokenOptimizationBenchmarkAsync(
      activeClauses,
      enrichedFiles,
      sqlTables,
      astFindings
    );

    const defaultRagReport = await executeStoreBackedRagQuery(
      'Which SQL tables and Python endpoints violate GDPR Art. 17 72-hour retention and tenant-isolated KMS encryption?',
      activeClauses,
      sqlTables,
      astFindings,
      verification.proofs,
      5
    );

    res.json({
      mcpServers: getMcpServersCatalog(),
      externalMcpServers: await externalMcpServerStatus(),
      multiAgentReport,
      tokenBenchmark,
      defaultRagReport,
      promptLibrary: getPromptLibraryCatalog(),
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/optimization/compress', async (req, res) => {
  try {
    const { rawLegalText, rawCodeText } = (req.body || {}) as {
      rawLegalText?: string;
      rawCodeText?: string;
    };
    const rawFiles = readTargetRepoFiles();
    const { sqlTables, astFindings } = await analyzeFullRepositoryAsync(rawFiles);

    const sampleLegal =
      rawLegalText ||
      activeClauses[0]?.rawLegalText ||
      'Personal identifiable information must be encrypted at rest with tenant-isolated keys and purged within 72 hours.';
    const sampleCode = rawCodeText || rawFiles[1]?.content || '';

    const cavemanCompressed = compressLegalProseCaveman(sampleLegal);
    const codeburnCompressed = pruneCodeWithCodeburn(sampleCode);
    const graphifyCompressed = compressRepoToGraphifySExpr(sqlTables, astFindings);

    res.json({
      rawTokens: countTokens(sampleLegal) + countTokens(sampleCode),
      compressedTokens: countTokens(cavemanCompressed) + countTokens(graphifyCompressed),
      cavemanCompressed,
      codeburnCompressed,
      graphifyCompressed,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/workflows/n8n-export', (_req, res) => {
  res.json({
    name: 'LexCompiler Autonomous Regulatory Horizon-to-PR Pipeline (n8n)',
    nodes: [
      {
        id: '1',
        name: 'EUR-Lex & Federal Register Webhook / Cron Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        parameters: { interval: '15m' },
      },
      {
        id: '2',
        name: 'MCP Tool: lex-statute-ingest-mcp',
        type: '@n8n/n8n-nodes-langchain.mcpClientTool',
        parameters: {
          serverUrl: 'http://localhost:3001/api/mcp/lex-statute-ingest-mcp/rpc',
          toolName: 'fetch_live_regulatory_feed',
        },
      },
      {
        id: '3',
        name: 'MCP Tool: lex-deontic-compiler-mcp',
        type: '@n8n/n8n-nodes-langchain.mcpClientTool',
        parameters: {
          serverUrl: 'http://localhost:3001/api/mcp/lex-deontic-compiler-mcp/rpc',
          toolName: 'compile_prose_to_smt_and_rego',
        },
      },
      {
        id: '4',
        name: 'MCP Tool: lex-z3-prover-mcp (Microsoft Z3 Formal Check)',
        type: '@n8n/n8n-nodes-langchain.mcpClientTool',
        parameters: {
          serverUrl: 'http://localhost:3001/api/mcp/lex-z3-prover-mcp/rpc',
          toolName: 'prove_repository_compliance_z3',
        },
      },
      {
        id: '5',
        name: 'MCP Tool: lex-remediation-pr-mcp (Z3-gated fix bundle)',
        type: '@n8n/n8n-nodes-langchain.mcpClientTool',
        parameters: {
          serverUrl: 'http://localhost:3001/api/mcp/lex-remediation-pr-mcp/rpc',
          toolName: 'synthesize_and_verify_remediation_pr',
        },
      },
    ],
  });
});

/**
 * Mutate or compile raw legal prose for a specific clause (or add a new clause)
 */
app.post('/api/clauses/compile', async (req, res) => {
  try {
    const {
      clauseId,
      rawLegalText,
      title,
      citation,
      frameworkId,
      category,
      amendmentLabel,
      sourceUrl,
    } = req.body as {
      clauseId?: string;
      rawLegalText: string;
      title?: string;
      citation?: string;
      frameworkId?: ComplianceFrameworkId;
      category?: RuleCategory;
      amendmentLabel?: string;
      sourceUrl?: string;
    };

    if (!rawLegalText || !rawLegalText.trim()) {
      res.status(400).json({ error: 'rawLegalText is required' });
      return;
    }
    if (clauseId !== undefined && (typeof clauseId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(clauseId))) {
      res.status(400).json({ error: 'clauseId may only contain letters, digits, ".", "_" and "-" (max 120)' });
      return;
    }

    const existingIdx = activeClauses.findIndex((c) => c.id === clauseId);
    if (existingIdx >= 0) {
      const target = activeClauses[existingIdx];
      const compiledResult = await compileLegalProseToFormalPolicyAsync(
        rawLegalText,
        category || target.category,
        target.id,
        citation || target.citation
      );

      activeClauses[existingIdx] = {
        ...target,
        title: title || target.title,
        citation: citation || target.citation,
        rawLegalText: rawLegalText.trim(),
        illustrative: false,
        version: `v2026.${commitCounter + 4}-LIVE`,
        lastAmended: new Date().toISOString().slice(0, 10),
        deontic: compiledResult.deontic,
        compiled: compiledResult.compiled,
      };
    } else {
      const newId = clauseId || `CLAUSE-CUSTOM-${crypto.randomUUID().slice(0, 8)}`;
      const newCat: RuleCategory = category || inferRuleCategoryFromProse(rawLegalText);
      const newCit = citation || 'Custom DPA Amendment §4.2';
      const knownFramework =
        typeof frameworkId === 'string' && Object.hasOwn(FRAMEWORK_DISPLAY_NAMES, frameworkId)
          ? frameworkId
          : undefined;
      const compiledResult = await compileLegalProseToFormalPolicyAsync(
        rawLegalText,
        newCat,
        newId,
        newCit
      );

      activeClauses.unshift({
        id: newId,
        frameworkId: knownFramework ?? 'ENTERPRISE_DPA',
        frameworkName: knownFramework
          ? FRAMEWORK_DISPLAY_NAMES[knownFramework]
          : 'Custom Enterprise DPA / Regulatory Statute',
        ...(typeof sourceUrl === 'string' && /^https?:\/\//.test(sourceUrl) ? { sourceUrl } : {}),
        citation: newCit,
        title: title || 'Custom Compiled Neuro-Symbolic Legal Obligation',
        severity: 'CRITICAL',
        category: newCat,
        rawLegalText: rawLegalText.trim(),
        version: 'v2026.LIVE',
        lastAmended: new Date().toISOString().slice(0, 10),
        deontic: compiledResult.deontic,
        compiled: compiledResult.compiled,
      });
    }

    activeAmendmentLabel =
      amendmentLabel || `Live Clause Mutation (${citation || clauseId || 'Custom Prose'})`;
    persistClauses();
    const report = await buildFullComplianceReport({ recordToLedger: true });
    res.json(report);
  } catch (err) {
    console.error('Error compiling clause:', err);
    sendError(res, err);
  }
});

/**
 * Trigger a Regulatory Amendment Preset (e.g. 30 Days -> 72 Hours + Tenant-Isolated KMS)
 */
app.post('/api/clauses/mutate-preset', async (req, res) => {
  try {
    const { presetId, resetRepoFiles } = req.body as {
      presetId: string;
      resetRepoFiles?: boolean;
    };

    if (resetRepoFiles) {
      resetTargetRepoToBaseline();
      await resetTargetRepoGitHistory();
      commitCounter++;
    }

    const presets = getMutationPresets();
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) {
      res.status(404).json({ error: `Preset ${presetId} not found` });
      return;
    }

    const idx = activeClauses.findIndex((c) => c.id === preset.clauseId);
    if (idx >= 0) {
      const target = activeClauses[idx];
      const compiledResult = await compileLegalProseToFormalPolicyAsync(
        preset.mutatedLawText,
        target.category,
        target.id,
        target.citation
      );
      activeClauses[idx] = {
        ...target,
        rawLegalText: preset.mutatedLawText,
        version: `v2026.${commitCounter + 5}-AMENDED`,
        lastAmended: new Date().toISOString().slice(0, 10),
        deontic: compiledResult.deontic,
        compiled: compiledResult.compiled,
      };
    }

    activeAmendmentLabel = `${preset.name} (${preset.parameterDiffSummary})`;
    persistClauses();
    const report = await buildFullComplianceReport({ recordToLedger: true });
    res.json(report);
  } catch (err) {
    console.error('Error applying preset:', err);
    sendError(res, err);
  }
});

function remediationBlockedResponse(pr: RemediationPullRequest) {
  return {
    error:
      'Remediation PR did not pass the pre-PR Z3 sandbox gate; refusing to apply it. ' +
      `Unresolved clauses: ${(pr.unresolvedClauseIds || []).join(', ') || 'unknown'}.`,
    postPatchZ3Status: pr.postPatchZ3Status,
    unresolvedClauseIds: pr.unresolvedClauseIds || [],
  };
}

/**
 * Apply synthesized remediation patch for a specific architecture node (or file)
 */
app.post('/api/remediation/apply-node', async (req, res) => {
  try {
    const { nodeId, filePath } = req.body as { nodeId?: string; filePath?: string };
    const currentReport = await buildFullComplianceReport();
    const pr = currentReport.remediationPR;

    if (!pr) {
      res.json(currentReport);
      return;
    }
    if (pr.postPatchZ3Status !== 'SAT_COMPLIANT') {
      res.status(409).json(remediationBlockedResponse(pr));
      return;
    }

    const matchingPatches = pr.filePatches.filter(
      (fp) => (nodeId && fp.nodeId === nodeId) || (filePath && fp.filePath === filePath)
    );

    for (const patch of matchingPatches) {
      writeTargetRepoFile(patch.filePath, patch.patchedContent);
    }
    await commitTargetRepoChanges(
      `fix(compliance): apply LexCompiler AST patch for ${nodeId || filePath}`
    );
    commitCounter++;

    const updatedReport = await buildFullComplianceReport({ recordToLedger: true });
    res.json(updatedReport);
  } catch (err) {
    console.error('Error applying node patch:', err);
    sendError(res, err);
  }
});

/**
 * Apply all patches in the Remediation Pull Request to the target repository on disk
 */
app.post('/api/remediation/apply-pr', async (_req, res) => {
  try {
    const currentReport = await buildFullComplianceReport();
    const pr = currentReport.remediationPR;

    if (pr && pr.postPatchZ3Status !== 'SAT_COMPLIANT') {
      res.status(409).json(remediationBlockedResponse(pr));
      return;
    }

    if (pr) {
      for (const patch of pr.filePatches) {
        writeTargetRepoFile(patch.filePath, patch.patchedContent);
      }
      await commitTargetRepoChanges(
        `fix(compliance): merge LexCompiler Auto-PR #${pr.prNumber} (${pr.filePatches.length} Z3-verified files)`
      );
      commitCounter++;
    }

    const updatedReport = await buildFullComplianceReport({ recordToLedger: true });
    res.json(updatedReport);
  } catch (err) {
    console.error('Error applying full PR:', err);
    sendError(res, err);
  }
});

/** Whether GitHub pull-request creation is configured (no secrets are returned). */
app.get('/api/remediation/github', (_req, res) => {
  const options = githubPrOptionsFromEnv();
  res.json({ enabled: Boolean(options), repository: options?.repository || null });
});

/** Opens the current remediation as a GitHub pull request (requires LEXCOMPILER_GITHUB_TOKEN + LEXCOMPILER_GITHUB_REPO). */
app.post('/api/remediation/open-github-pr', async (_req, res) => {
  try {
    const options = githubPrOptionsFromEnv();
    if (!options) {
      res.status(400).json({ error: 'GitHub PR creation is not configured: set LEXCOMPILER_GITHUB_TOKEN and LEXCOMPILER_GITHUB_REPO.' });
      return;
    }
    const pr = (await buildFullComplianceReport()).remediationPR;
    if (!pr) {
      res.status(409).json({ error: 'Every clause is already SAT_COMPLIANT; there is nothing to open.' });
      return;
    }
    const opened = await openGitHubPullRequest(pr, options);
    res.json({ ...opened, prId: pr.prId });
  } catch (err) {
    if (err instanceof GitHubPrError) {
      res.status(err.status === 409 ? 409 : 502).json({ error: err.message });
      return;
    }
    sendError(res, err);
  }
});

/**
 * Update a file in target-repo directly from the Live IDE Editor and re-verify
 */
app.post('/api/repo/update-file', async (req, res) => {
  try {
    const { filePath, content } = req.body as { filePath: string; content: string };
    if (!filePath || typeof content !== 'string') {
      res.status(400).json({ error: 'filePath and content are required' });
      return;
    }

    writeTargetRepoFile(filePath, content);
    await commitTargetRepoChanges(`chore(repo): manual edit to ${filePath}`);
    commitCounter++;

    const updatedReport = await buildFullComplianceReport({ recordToLedger: true });
    res.json(updatedReport);
  } catch (err) {
    console.error('Error updating repo file:', err);
    sendError(res, err);
  }
});

/**
 * Reset target repository files & legal clauses to initial baseline
 */
app.post('/api/repo/reset', async (req, res) => {
  try {
    const { mode } = (req.body || {}) as { mode?: 'LEGACY_30D_COMPLIANT_DPA' | 'AMENDED_72H' };
    resetTargetRepoToBaseline();
    await resetTargetRepoGitHistory();
    activeClauses = getInitialClauses();
    commitCounter++;

    if (mode === 'LEGACY_30D_COMPLIANT_DPA') {
      const legacyText =
        'Section 4.2 (Legacy Data Retention Baseline): All Personal Identifiable Information (PII) persisted in relational tables or cache workers must be encrypted at rest and purged within 30 days (720 hours) of session termination.';
      const idx = activeClauses.findIndex((c) => c.id === 'CLAUSE-DPA-4.2');
      if (idx >= 0) {
        const target = activeClauses[idx];
        const compiledResult = await compileLegalProseToFormalPolicyAsync(
          legacyText,
          target.category,
          target.id,
          target.citation
        );
        activeClauses[idx] = {
          ...target,
          title: 'Legacy 30-Day PII Retention & Standard AES-256 Baseline',
          rawLegalText: legacyText,
          version: 'v2025.1-BASELINE',
          deontic: compiledResult.deontic,
          compiled: compiledResult.compiled,
        };
      }
      activeAmendmentLabel =
        'Legacy 30-Day (720h) Contract Baseline — Ready for Amendment Shockwave';
    } else {
      activeAmendmentLabel =
        'Amended DPA §4.2 / GDPR Art. 17: 72-Hour Purge + Tenant-Isolated KMS Keys';
    }

    persistClauses();
    const report = await buildFullComplianceReport({ recordToLedger: true });
    res.json(report);
  } catch (err) {
    console.error('Error resetting repo:', err);
    sendError(res, err);
  }
});

/**
 * Switch statutory corpus locale between Global English ('en') and Bangladesh Bangla ('bn')
 */
app.post('/api/clauses/switch-locale', async (req, res) => {
  try {
    const { locale, resetRepo } = (req.body || {}) as {
      locale: 'en' | 'bn';
      resetRepo?: boolean;
    };
    if (resetRepo) {
      resetTargetRepoToBaseline();
      await resetTargetRepoGitHistory();
      commitCounter++;
    }
    if (locale === 'bn') {
      activeClauses = getBanglaInitialClauses();
      activeAmendmentLabel =
        'বাংলাদেশ ব্যাংক আইসিটি নীতিমালা ধারা ৪.২ (৪৮ ঘণ্টা রিটেনশন ও টেন্যান্ট KMS)';
    } else {
      activeClauses = getInitialClauses();
      activeAmendmentLabel =
        'Amended DPA §4.2 / GDPR Art. 17: 72-Hour Purge + Tenant-Isolated KMS Keys';
    }
    persistClauses();
    const report = await buildFullComplianceReport({ recordToLedger: true });
    res.json(report);
  } catch (err) {
    console.error('Error switching locale:', err);
    sendError(res, err);
  }
});

app.get('/api/sandbox/verify-runtime', async (_req, res) => {
  if (!securityConfig.runtimeSandboxEnabled) {
    res.status(403).json({
      error:
        'Runtime sandbox is disabled. It executes target-repo Python in a local process that is not an isolation boundary. ' +
        'Set LEXCOMPILER_ENABLE_RUNTIME_SANDBOX=1 to enable it on a trusted machine.',
      disabled: true,
    });
    return;
  }
  try {
    const aiClause = activeClauses.find((c) => c.category === 'AI_HUMAN_IN_THE_LOOP');
    const egressClause = activeClauses.find((c) => c.category === 'CROSS_BORDER_TRANSFER');
    const runtimeReport = await executeRealWorldSandboxVerification({
      minAiConfidence: aiClause?.deontic.extractedParameters.minAiConfidenceThreshold,
      allowedRegions: egressClause?.deontic.extractedParameters.allowedDataRegions,
    });
    res.json(runtimeReport);
  } catch (err) {
    console.error('Error executing real-world sandbox verification:', err);
    sendError(res, err);
  }
});

// ============================================================================
// REAL MULTI-LLM, NEURAL EMBEDDING & SERVICE MESH TELEMETRY ENDPOINTS
// ============================================================================

app.get('/api/services/mesh', async (_req, res) => {
  try {
    const mesh = await getLiveServiceMeshTelemetry();
    res.json(mesh);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/llm/generate', async (req, res) => {
  try {
    // Keys are never taken from the request: cloud calls use the server's configured model.
    const { model, prompt, systemPrompt, maxTokens, cloudProvider } = req.body || {};
    const result = await runRealLlmInference({
      model: typeof model === 'string' && model ? model : 'qwen2.5-coder:0.5b',
      prompt:
        prompt ||
        'Explain why GDPR Art. 17 requires 72h TTL and tenant-isolated KMS keys in Postgres and FastAPI.',
      systemPrompt,
      maxTokens: Math.min(Number(maxTokens) || 120, 1024),
      cloudProvider,
      task: 'playground',
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/llm/multi-model-pipeline', async (req, res) => {
  try {
    const { clauseText, codeSnippet, preferredLegalModel } = req.body || {};
    const legalText =
      clauseText ||
      activeClauses[0]?.rawLegalText ||
      'PII must be encrypted at rest with tenant-isolated keys and purged within 72 hours.';
    const snippet =
      codeSnippet ||
      `logger.info(f"Ingesting patient record ssn={payload.ssn} email={payload.email}")\nencrypted_ssn = encrypt_shared_aes256(payload.ssn)`;

    // 1. Real 384-d Neural Embeddings via all-minilm:latest on Ollama
    const [lawEmbed, codeEmbed] = await Promise.all([
      computeRealNeuralEmbedding(legalText),
      computeRealNeuralEmbedding(snippet),
    ]);

    let cosineSim = 0;
    if (lawEmbed.embedding.length > 0 && codeEmbed.embedding.length > 0) {
      let dot = 0;
      let nA = 0;
      let nB = 0;
      for (let i = 0; i < lawEmbed.embedding.length; i++) {
        dot += lawEmbed.embedding[i] * codeEmbed.embedding[i];
        nA += lawEmbed.embedding[i] * lawEmbed.embedding[i];
        nB += codeEmbed.embedding[i] * codeEmbed.embedding[i];
      }
      cosineSim =
        Math.round((dot / (Math.sqrt(nA) * Math.sqrt(nB) || 1)) * 10000) / 10000;
    }

    // 2. Real Code LLM Inference via qwen2.5-coder:0.5b on Ollama
    const codeLlmRes = await runRealLlmInference({
      model: 'qwen2.5-coder:0.5b',
      prompt: `Analyze this code snippet against the rule "${legalText}":\n${snippet}\nProvide a concise 2-sentence technical explanation of the violation and the code fix.`,
      maxTokens: 110,
      task: 'code-explanation',
    });

    // 3. Real Legal / General Counsel LLM Inference (dolphin3:latest or qwen2.5-coder)
    const legalModelName = preferredLegalModel || 'qwen2.5-coder:0.5b';
    const legalLlmRes = await runRealLlmInference({
      model: legalModelName,
      prompt: `As General Counsel, write a 2-sentence formal compliance attestation explaining how enforcing tenant-isolated KMS keys and 72-hour TTL satisfies "${legalText}".`,
      maxTokens: 110,
      task: 'legal-attestation',
    });

    res.json({
      executedAt: new Date().toISOString(),
      neuralEmbedding: {
        model: lawEmbed.modelUsed,
        dimensions: lawEmbed.embedding.length || 384,
        lawVectorPreview: lawEmbed.embedding.slice(0, 8),
        codeVectorPreview: codeEmbed.embedding.slice(0, 8),
        cosineSimilarity: cosineSim,
        latencyMs: Math.round((lawEmbed.latencyMs + codeEmbed.latencyMs) * 100) / 100,
      },
      codeSpecialistLlm: codeLlmRes,
      generalCounselLlm: legalLlmRes,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
// ENTERPRISE STARTUP SUITE: ED25519 CRYPTO CERTIFICATES, SARIF 2.1.0, BYOC SCAN
// ============================================================================

app.get('/api/enterprise/certificate', async (_req, res) => {
  try {
    const report = await buildFullComplianceReport();
    const cert = await generateSignedConformityCertificate(report);
    res.json(cert);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/enterprise/public-key', async (_req, res) => {
  try {
    const signer = await getAttestationSigner();
    res.json({ keyId: signer.keyId, algorithm: signer.algorithm, backend: signer.backend, publicKeyPem: signer.publicKeyPem, trustedKeys: trustedKeys(), revocations: revocations() });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/enterprise/verify-signature', async (req, res) => {
  try {
    const { canonicalPayloadJson, signatureHex, publicKeyPem, keyId, certificateId, timestamp } = (req.body || {}) as {
      canonicalPayloadJson: string;
      signatureHex: string;
      publicKeyPem?: string;
      keyId?: string;
      certificateId?: string;
      timestamp?: { tokenBase64: string };
    };
    const result = verifyEd25519CertificateSignature(canonicalPayloadJson, signatureHex, publicKeyPem, { keyId, certificateId });
    const ts = timestamp?.tokenBase64 ? await verifyTimestamp(timestamp.tokenBase64, Buffer.from(signatureHex, 'hex')) : undefined;
    res.json({ ...result, ...(ts ? { timestamp: ts, verified: result.verified && ts.valid } : {}) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/enterprise/revoke', (req, res) => {
  const who = res.locals.principal as { globalRole?: string } | undefined;
  if (who?.globalRole !== 'admin') return void res.status(403).json({ error: 'Only administrators can revoke attestations.' });
  try {
    res.json(revoke({ certificateId: req.body?.certificateId, keyId: req.body?.keyId, reason: req.body?.reason }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/enterprise/revocations', (_req, res) => res.json(revocations()));

app.get('/api/enterprise/sarif', async (_req, res) => {
  try {
    const report = await buildFullComplianceReport();
    const identity = await resolveRepositoryIdentity(report.merkleAuditRoot);
    // Paths in SARIF are relative to the checkout the report is uploaded from.
    const rel = path.relative(process.cwd(), TARGET_REPO_ROOT);
    const uriPrefix = TARGET_REPO_IS_FIXTURE && rel && !rel.startsWith('..') ? `${rel.split(path.sep).join('/')}/` : '';
    const sarif = generateSarifReport(
      report.clauses,
      report.proofs,
      { commitHash: identity.commitHash, branch: identity.branch, remoteUrl: identity.remoteUrl },
      uriPrefix
    );
    res.json(sarif);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/enterprise/byoc-scan', async (req, res) => {
  try {
    const { contractClauseText, citationLabel, language, fileName, sourceCode } =
      req.body || {};
    const result = await executeByocCustomScan({
      contractClauseText:
        contractClauseText ||
        'All customer payment tokens and PII must be encrypted with tenant-isolated KMS keys, never logged in plaintext, and purged within 48 hours.',
      citationLabel: citationLabel || 'Custom Enterprise MSA §7.1',
      language: language || 'python',
      fileName: fileName || 'custom_payment_service.py',
      sourceCode:
        sourceCode ||
        `# Custom Enterprise Payment & PII Handler\nimport logging\nlogger = logging.getLogger("payments")\n\nTENANT_ISOLATED_KMS = False\nRETENTION_HOURS = 360\n\ndef process_customer(ssn: str, email: str):\n    logger.info(f"Processing customer ssn={ssn} email={email}")\n    return encrypt_shared_aes256(ssn)\n`,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// GitHub App pages: register, install, link, and the scan report linked from check runs.
app.use(
  createGitHubRoutes({
    store: productStore,
    queue: jobQueue,
    getApp: getGitHubApp,
    onRegistered: (credentials) => {
      githubApp = new GitHubApp(credentials, ghUrls);
    },
    auth: createBrowserAuth(oidcProvider, { sessions: sessionStore, signInRequired }),
    publicUrl,
    urls: ghUrls,
    webhookUrl: process.env.LEXCOMPILER_GITHUB_WEBHOOK_URL || `${publicUrl}/api/github/webhooks`,
  })
);

// Serve built frontend in production
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next();
  });
});

jobQueue.start();

app.listen(securityConfig.port, securityConfig.host, () => {
  console.log(
    `[LexCompiler Server] Neuro-Symbolic Law-to-AST Engine listening on http://${securityConfig.host}:${securityConfig.port}` +
      (signInRequired ? ` (sign-in required: ${oidcProvider ? 'OIDC' : 'email and password'})` : securityConfig.apiToken ? ' (API token required)' : ' (loopback only)')
  );
});
