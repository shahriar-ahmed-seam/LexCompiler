export type DeonticModality = 'OBLIGATION' | 'PROHIBITION' | 'PERMISSION';

export type ComplianceFrameworkId =
  | 'ENTERPRISE_DPA'
  | 'GDPR'
  | 'EU_AI_ACT'
  | 'HIPAA'
  | 'CCPA_CPRA';

export type RuleCategory =
  | 'RETENTION_AND_TENANT_KMS'
  | 'ENCRYPTION_AT_REST'
  | 'PII_LOGGING_BAN'
  | 'RIGHT_TO_ERASURE_CASCADE'
  | 'AI_HUMAN_IN_THE_LOOP'
  | 'CROSS_BORDER_TRANSFER'
  | 'CONSENT_LAWFUL_BASIS'
  | 'BREACH_NOTIFICATION'
  | 'DPIA_REQUIRED'
  | 'DATA_MINIMISATION'
  | 'PURPOSE_LIMITATION';

export type DeonticExtractionMethod =
  | 'DETERMINISTIC_PARSER'
  | 'LLM_JSON_FALLBACK'
  | 'DETERMINISTIC_DEFAULT'
  /** A value Legal set or confirmed on the rule card. */
  | 'LEGAL_REVIEW';

export interface DeonticExtractionProvenance {
  method: DeonticExtractionMethod;
  evidence: string[];
  llmModel?: string;
  llmLatencyMs?: number;
  llmRejectedReason?: string;
  /** Ambiguities a human should confirm (several durations found, negation detected, …). */
  reviewNotes?: string[];
}

export interface DeonticExtraction {
  modality: DeonticModality; // O (Obligation), F (Prohibition), P (Permission)
  deonticOperatorSymbol: 'O(φ)' | 'F(φ)' | 'P(φ)';
  actor: string;
  regulatedAction: string;
  targetDataScope: string[];
  normativeCondition: string;
  formalPredicateSummary: string;
  extractedParameters: {
    maxRetentionHours?: number;
    maxRetentionDays?: number;
    requiresTenantIsolatedKeys?: boolean;
    requiredEncryptionAlgorithms?: string[];
    forbidPlaintextLogging?: boolean;
    requireCascadeErasure?: boolean;
    minAiConfidenceThreshold?: number;
    requireHumanOversightGate?: boolean;
    allowedDataRegions?: string[];
    prohibitedDataRegions?: string[];
    requireImmutableAuditLog?: boolean;
    requireEncryptionAtRest?: boolean;
    requireConsentCheck?: boolean;
    maxBreachNotificationHours?: number;
    requireDpia?: boolean;
    forbidUnusedPiiFields?: boolean;
    allowedProcessingPurposes?: string[];
  };
  extractionProvenance?: DeonticExtractionProvenance;
}

export interface CompiledPolicyArtifacts {
  deonticFormula: string;
  firstOrderLogic: string;
  smtLib2Snippet: string;
  opaRegoRule: string;
  astPatternQuery: string;
}

export interface LegalClause {
  id: string;
  frameworkId: ComplianceFrameworkId;
  frameworkName: string;
  citation: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  category: RuleCategory;
  rawLegalText: string;
  version: string;
  lastAmended: string;
  sourceUrl?: string;
  /**
   * Built-in demo text: a paraphrase whose numeric thresholds are scenario
   * parameters, not wording from the cited law.
   */
  illustrative?: boolean;
  deontic: DeonticExtraction;
  compiled: CompiledPolicyArtifacts;
}

export interface SQLColumnNode {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
  isPII: boolean;
  piiClassification?:
    | 'DIRECT_IDENTIFIER'
    | 'HEALTH_PHI'
    | 'FINANCIAL_PCI'
    | 'BIOMETRIC'
    | 'BEHAVIORAL'
    | 'NONE';
  encryptedAtRest: boolean;
  encryptionAlgorithm?: string;
  hasTenantKeyIsolation?: boolean;
  foreignKeyReference?: {
    table: string;
    column: string;
    onDeleteCascade: boolean;
    implicit?: boolean;
  };
  /** What classified the column: an @pii annotation, its name, its type, its schema documentation or CHECK pattern, or a value. */
  piiInference?: 'ANNOTATION' | 'NAME_PATTERN' | 'TYPE' | 'SCHEMA' | 'VALUE' | 'NONE';
  line: number;
}

export interface SQLDependentForeignKey {
  childTable: string;
  childColumn: string;
  filePath: string;
  line: number;
  onDeleteCascade: boolean;
  implicit: boolean;
}

export interface SQLTableSchema {
  tableName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  containsPII: boolean;
  retentionHoursConfigured: number | null;
  retentionDaysConfigured: number | null;
  hasTenantKeyIsolation: boolean;
  hasErasureCascade: boolean;
  encryptedColumnsCount: number;
  unencryptedPiiColumns: string[];
  columns: SQLColumnNode[];
  dependentForeignKeys?: SQLDependentForeignKey[];
}

export type SourceEditAnchorRole =
  | 'RETENTION_TTL_LITERAL'
  | 'RETENTION_ANNOTATION_LITERAL'
  | 'TENANT_KMS_FLAG'
  | 'CIPHER_LABEL'
  | 'SHARED_KEY_ENCRYPT_CALL'
  | 'PII_LOG_ARGUMENT'
  | 'AI_CONFIDENCE_THRESHOLD'
  | 'HUMAN_OVERSIGHT_FLAG'
  | 'AUDIT_LOG_FLAG'
  | 'EGRESS_REGION_LITERAL'
  | 'SOVEREIGN_BOUNDARY_FLAG'
  | 'SQL_COLUMN_INSERTION_POINT'
  | 'SQL_COLUMN_ENCRYPTION_ANNOTATION'
  | 'SQL_FOREIGN_KEY_ON_DELETE'
  | 'PII_MODEL_FIELD'
  | 'CONSENT_CHECK_INSERTION_POINT'
  | 'PROCESSING_PURPOSE_LITERAL'
  | 'BREACH_DEADLINE_LITERAL';

/**
 * Exact source span of a value the remediation synthesizer may rewrite.
 * Lines are 1-based; columns are 0-based UTF-16 offsets into the line.
 */
export interface SourceEditAnchor {
  role: SourceEditAnchorRole;
  symbol: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  sourceText: string;
  numericValue?: number;
  booleanValue?: boolean;
  stringValue?: string;
  hoursPerUnit?: number;
  context?: Record<string, string>;
}

/** Symbolic expression produced by the analyzer's symbolic execution (constants folded, inputs free). */
export type SymExpr =
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'str'; v: string }
  | { k: 'var'; name: string; sort: 'num' | 'bool' | 'str' }
  | { k: 'op'; op: 'and' | 'or' | 'not' | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'add' | 'sub' | 'mul' | 'div' | 'neg'; args: SymExpr[] }
  | { k: 'ite'; c: SymExpr; t: SymExpr; e: SymExpr };

/** One feasible-or-not execution path of a function: its path condition and returned fields. */
export interface SymPath {
  pc: SymExpr;
  returns: Record<string, SymExpr>;
  /** Calls made on this path, in order, with the argument PII fields they receive. */
  events?: Array<{ call: string; line: number; leaks?: string[] }>;
}

export interface SymbolicSummary {
  functionName: string;
  paths: SymPath[];
  /** Constructs the executor could not model exactly; their values were left unconstrained. */
  approximations: string[];
}

export interface ASTFindingNode {
  id: string;
  filePath: string;
  line: number;
  endLine: number;
  column: number;
  language: 'python' | 'typescript' | 'sql';
  astNodeKind: string;
  constructType:
    | 'FASTAPI_ENDPOINT'
    | 'PII_PROCESSING_FUNCTION'
    | 'REDIS_CACHE_WORKER'
    | 'DATA_RETENTION_POLICY'
    | 'POSTGRES_DDL_TABLE'
    | 'LOGGER_CALL'
    | 'LLM_INFERENCE_CALL'
    | 'CROSS_BORDER_EGRESS'
    | 'ERASURE_HANDLER'
    | 'PII_ENTRYPOINT'
    | 'PII_COLLECTION_MODEL'
    | 'BREACH_NOTIFICATION_POLICY'
    | 'DPIA_RECORD';
  functionName: string;
  codeSnippet: string;
  metadata: {
    usesTenantIsolatedKms?: boolean;
    encryptionCipher?: string;
    encryptsPii?: boolean;
    retentionTtlHours?: number | null;
    logsPlaintextPii?: boolean;
    leakedFields?: string[];
    hasHumanOversightGate?: boolean;
    aiConfidenceThreshold?: number | null;
    writesAuditLog?: boolean;
    egressRegion?: string;
    sovereignGuardEnabled?: boolean;
    hasCascadeDelete?: boolean;
    containsPii?: boolean;
    /** How the retention value was obtained, e.g. "PII_CACHE_TTL_HOURS (hours)" or "setex literal (seconds)". */
    retentionSource?: string;
    /** True when the TTL unit was not stated in the identifier and hours were assumed. */
    retentionUnitAssumed?: boolean;
    /** PII_ENTRYPOINT: a consent / lawful-basis check is called before processing. */
    hasConsentCheck?: boolean;
    /** PII_ENTRYPOINT: processing purpose declared by the module (PROCESSING_PURPOSE) or the handler. */
    declaredPurpose?: string | null;
    /** PII_COLLECTION_MODEL: PII fields the model collects, and those never read by the module. */
    collectedPiiFields?: string[];
    unusedPiiFields?: string[];
    /** Per PII field: the category and which signals (name, type, schema, value) classified it. */
    piiFieldEvidence?: Record<string, { pii: boolean; category?: string; evidence: Array<'name' | 'type' | 'schema' | 'value'> }>;
    /** BREACH_NOTIFICATION_POLICY: configured supervisory-authority notification deadline. */
    breachNotificationHours?: number | null;
    /** DPIA_RECORD: reference to the impact assessment, and whether that file exists in the repository. */
    dpiaReference?: string | null;
    dpiaRecordExists?: boolean;
    /** Symbolic execution of the function (paths, path conditions, returned values). */
    symbolic?: SymbolicSummary;
  };
  editAnchors?: SourceEditAnchor[];
}

export interface ArchitectureGraphNode {
  id: string;
  label: string;
  sublabel: string;
  nodeRole:
    | 'POSTGRES_SCHEMA'
    | 'FASTAPI_ENDPOINT'
    | 'REDIS_WORKER'
    | 'AI_DECISION_ENGINE'
    | 'CROSS_BORDER_SYNC'
    | 'ERASURE_CONTROLLER';
  layer: 'INGRESS_API' | 'SERVICE_LOGIC' | 'CACHE_AND_WORKERS' | 'DATA_STORAGE' | 'EXTERNAL_EGRESS';
  language: 'python' | 'typescript' | 'sql';
  filePath: string;
  line: number;
  endLine: number;
  status: 'COMPLIANT' | 'VIOLATION' | 'WARNING';
  violatedClauseIds: string[];
  dataClassifications: string[];
  astSummary: string;
  metrics: Record<string, string | number | boolean>;
}

export interface ArchitectureGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  dataPayload: string[];
  isEncrypted: boolean;
  isTenantIsolated: boolean;
  isCrossBorder?: boolean;
  targetRegion?: string;
  violatedClauseIds: string[];
}

export interface TargetRepoFile {
  path: string;
  language: 'python' | 'typescript' | 'sql';
  description: string;
  content: string;
  lastModified: string;
  astNodeCount?: number;
}

export interface Z3FormalProofStep {
  stepNumber: number;
  ruleName: string;
  formula: string;
  justification: string;
}

export type Z3RepairAction =
  | 'SET_RETENTION_BOUND'
  | 'ADD_RETENTION_COLUMN'
  | 'ADD_TENANT_KMS_COLUMN'
  | 'ENABLE_TENANT_KMS'
  | 'REDACT_LOG_ARGUMENTS'
  | 'RAISE_CONFIDENCE_GATE'
  | 'ENABLE_HUMAN_OVERSIGHT'
  | 'ENABLE_AUDIT_LOG'
  | 'PIN_EGRESS_REGION'
  | 'ENABLE_SOVEREIGN_GUARD'
  | 'ENCRYPT_COLUMN'
  | 'CASCADE_FOREIGN_KEY'
  | 'INSERT_CONSENT_CHECK'
  | 'SET_BREACH_DEADLINE'
  | 'ADD_BREACH_POLICY'
  | 'REMOVE_UNUSED_PII_FIELD'
  | 'PIN_PROCESSING_PURPOSE';

/** A violated code fact from the Z3 unsat core, with the minimal-change value Z3 Optimize found for it. */
export interface Z3RepairTarget {
  factLabel: string;
  z3Variable: string;
  repairAction: Z3RepairAction;
  findingId: string;
  nodeId: string;
  filePath: string;
  language: 'python' | 'typescript' | 'sql';
  anchorSymbol?: string;
  currentValue: number | boolean | string | null;
  requiredValue: number | boolean | string;
}

export interface ClauseVerificationProof {
  clauseId: string;
  citation: string;
  title: string;
  frameworkId: ComplianceFrameworkId;
  category: RuleCategory;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  /** UNKNOWN_NEEDS_REVIEW: Z3 returned `unknown` (e.g. timeout); never counted as compliant. */
  status: 'SAT_COMPLIANT' | 'UNSAT_VIOLATION' | 'UNKNOWN_NEEDS_REVIEW';
  z3SolverStatus: 'sat' | 'unsat' | 'unknown';
  z3SolveTimeMs: number;
  /** Number of code constructs (tables, endpoints, workers, …) the clause was checked against. */
  applicableInstanceCount?: number;
  /** Set when the clause's bounds came from defaults or an LLM fallback, or no construct applied. */
  reviewReasons?: string[];
  smtLib2Executed: string;
  unsatCoreAssertions: string[];
  unsatCoreIterations?: string[][];
  z3ModelAssignments?: Record<string, string | number | boolean>;
  repairTargets?: Z3RepairTarget[];
  counterexampleWitness: Record<string, string | number | boolean>;
  formalProofSteps: Z3FormalProofStep[];
  /** Denials from `opa eval` when OPA is installed; otherwise derived from the Z3 result. */
  opaRegoTriggeredDenials: string[];
  /** 'opa' when the generated Rego was evaluated by OPA, 'z3-derived' otherwise. */
  policyDenialSource?: 'opa' | 'z3-derived';
  /** OPA evaluation error, if OPA was available but failed. */
  opaError?: string;
  affectedGraphNodeIds: string[];
  offendingLocations: Array<{
    nodeId: string;
    filePath: string;
    language: 'python' | 'typescript' | 'sql';
    line: number;
    endLine: number;
    codeSnippet: string;
    explanation: string;
    astNodeType: string;
    remediationPreview: string;
  }>;
  cryptographicProvenance: {
    statuteSha256: string;
    deonticIrSha256: string;
    smtFormulaSha256: string;
    astSnapshotSha256: string;
    merkleProofHash: string;
    timestampIso: string;
  };
}

export interface FilePatchDiff {
  nodeId: string;
  filePath: string;
  language: 'python' | 'typescript' | 'sql';
  summary: string;
  offendingLineStart: number;
  offendingLineEnd: number;
  originalContent: string;
  patchedContent: string;
  unifiedDiff: string;
  linesAdded: number;
  linesRemoved: number;
  addressedClauseIds: string[];
  /** Result of re-parsing the patched file (Python ast, TypeScript parser, SQL tokenizer). */
  syntaxCheck?: { passed: boolean; message?: string };
}

export interface RemediationPullRequest {
  prId: string;
  /** Always 0: LexCompiler produces a local remediation bundle, not a GitHub pull request. */
  prNumber: number;
  title: string;
  branchName: string;
  baseBranch: string;
  /** READY_TO_MERGE only when every clause is SAT_COMPLIANT after patching. */
  status: 'READY_TO_MERGE' | 'BLOCKED_UNRESOLVED' | 'APPLIED_TO_REPO';
  createdAt: string;
  triggeredBy: string;
  addressedViolationsCount: number;
  addressedClauses: Array<{
    clauseId: string;
    citation: string;
    title: string;
  }>;
  prePatchZ3Status: 'UNSAT_VIOLATION';
  postPatchZ3Status: 'SAT_COMPLIANT' | 'UNSAT_VIOLATION';
  postPatchVerifyTimeMs: number;
  cegisIterations?: number;
  unresolvedClauseIds?: string[];
  /** Patched files that no longer parse; any entry blocks the PR. */
  validationErrors?: string[];
  cryptographicAttestationHash: string;
  executiveSummary: string;
  filePatches: FilePatchDiff[];
}

export interface RegulatoryMutationPreset {
  id: string;
  name: string;
  badge: string;
  frameworkId: ComplianceFrameworkId;
  clauseId: string;
  description: string;
  previousLawExcerpt: string;
  mutatedLawText: string;
  parameterDiffSummary: string;
  blastRadiusNodeIds: string[];
}

export interface LiveRegulatoryFeedItem {
  id: string;
  source: 'EUR_LEX' | 'FEDERAL_REGISTER';
  documentNumber: string;
  title: string;
  publicationDate: string;
  agencyOrBody: string;
  excerpt: string;
  url: string;
  suggestedFramework: ComplianceFrameworkId;
  /** Curated or offline demo text that is not (or not only) the official publication. */
  illustrative?: boolean;
  /**
   * TEXT (default): the excerpt states obligations that can be compiled.
   * CHANGE_NOTICE: another act amends or corrects a tracked regulation; there is no text to compile.
   */
  kind?: 'TEXT' | 'CHANGE_NOTICE';
}

// ============================================================================
// AI-HEAVY EXTENSIONS: 6+ MCP SERVERS, HYBRID CONTEXTUAL+GRAPH RAG,
// 6-AGENT ORCHESTRATOR, TOKEN OPTIMIZATION LAB, AND DATA LIFECYCLE
// ============================================================================

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sampleArgs: Record<string, unknown>;
}

export interface McpServerDescriptor {
  id: string;
  name: string;
  role: 'BUILT_CUSTOM' | 'INTEGRATED_EXTERNAL';
  version: string;
  transports: Array<'stdio' | 'streamable-http'>;
  endpointUrl: string;
  stdioCommand: string;
  status: 'ONLINE' | 'READY';
  description: string;
  toolsCount: number;
  resourcesCount: number;
  promptsCount: number;
  tools: McpToolDefinition[];
}

export interface McpToolInvocationResult {
  invocationId: string;
  serverId: string;
  toolName: string;
  transportUsed: 'streamable-http' | 'stdio';
  latencyMs: number;
  jsonRpcRequest: {
    jsonrpc: '2.0';
    id: string;
    method: 'tools/call';
    params: {
      name: string;
      arguments: Record<string, unknown>;
    };
  };
  /** Exactly what the JSON-RPC endpoint returns: a result (possibly isError) or an error. */
  jsonRpcResponse: {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: {
      content: Array<{ type: 'text'; text: string }>;
      structuredContent?: unknown;
      isError: boolean;
    };
    error?: { code: number; message: string; data?: unknown };
  };
  timestamp: string;
}

export interface ContextualRagChunk {
  chunkId: string;
  sourceType: 'LEGAL_STATUTE' | 'POLYGLOT_AST_NODE' | 'SQL_DDL_SCHEMA' | 'FORMAL_SMT_AXIOM';
  sourceId: string;
  citationOrPath: string;
  chunkStrategy: 'SEMANTIC_PROPOSITION' | 'LATE_CHUNKING' | 'AST_SUBTREE';
  rawChunkText: string;
  anthropicContextualPrefix: string;
  contextualizedText: string;
  tokenCount: number;
  embeddingDimension: number;
  embeddingPreview: number[];
  linkedGraphEntities: string[];
}

export interface KnowledgeGraphTriple {
  id: string;
  subject: string;
  subjectType: 'STATUTE' | 'DEONTIC_RULE' | 'SMT_ASSERTION' | 'AST_NODE' | 'SQL_COLUMN';
  predicate:
    | 'IMPOSES_OBLIGATION'
    | 'COMPILES_TO_SMT'
    | 'CONSTRAINS_AST_NODE'
    | 'PERSISTS_IN_COLUMN'
    | 'VIOLATES_INVARIANT'
    | 'REMEDIATED_BY_PATCH';
  object: string;
  objectType: 'DEONTIC_RULE' | 'SMT_ASSERTION' | 'AST_NODE' | 'SQL_COLUMN' | 'PR_PATCH';
  cypherQuerySnippet: string;
}

export interface RagRetrievedItem {
  chunk: ContextualRagChunk;
  denseVectorScore: number;
  bm25KeywordScore: number;
  graphTraversalBoost: number;
  rrfHybridScore: number;
  crossEncoderRerankScore: number;
  cragVerdict: 'CORRECT_HIGH_CONFIDENCE' | 'AMBIGUOUS_REFINED';
}

export interface RagasEvaluationMetrics {
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  answerRelevance: number;
  deonticAlignmentScore: number;
  overallRagasScore: number;
  /** How the scores were computed (labels, judge model, …). */
  evaluationMethod?: string;
}

export interface RagQueryExecutionReport {
  queryId: string;
  originalQuery: string;
  hydeHypotheticalFormalQuery: string;
  rewrittenDeonticQuery: string;
  techniquesExecuted: string[];
  latencyMs: number;
  retrievedChunks: RagRetrievedItem[];
  matchedGraphTriples: KnowledgeGraphTriple[];
  synthesizedNeuroSymbolicAnswer: string;
  ragasMetrics: RagasEvaluationMetrics;
  vectorDbBackend: string;
  graphDbBackend: string;
}

export interface AgentExecutionStep {
  stepNumber: number;
  agentId: string;
  agentName: string;
  /** What ran the step: "LexCompiler agent runtime" when a model is configured, otherwise "None (direct tool call)". */
  frameworkUsed: string;
  /** The model that ran, or "No model: direct tool call". */
  llmModel: string;
  /** Where the model ran: a cloud API, a server on this machine (Ollama, vLLM), or no model. */
  runtime: 'cloud' | 'local' | 'none';
  /** Framework of the agent's optional Python adapter (agents/lexcompiler_agents); not used by this pipeline. */
  pythonAdapter?: string;
  mcpServerCalled: string;
  mcpToolCalled: string;
  inputTokensRaw: number;
  inputTokensOptimized: number;
  outputTokens: number;
  latencyMs: number;
  status: 'COMPLETED' | 'FAILED';
  reasoningSummary: string;
  structuredArtifactPreview: string;
  /** LLM_AGENT: a configured model chose and called the tools; DIRECT_TOOL_CALL: no model configured. */
  execution?: 'LLM_AGENT' | 'DIRECT_TOOL_CALL';
  /** Provider-reported usage when an LLM ran (including cached prompt tokens). */
  llmUsage?: { promptTokens: number; completionTokens: number; cachedPromptTokens: number; cacheWriteTokens: number };
  toolCallsMade?: Array<{ name: string; ok: boolean; latencyMs: number }>;
}

export interface MultiAgentPipelineReport {
  runId: string;
  triggeredAt: string;
  orchestrationPattern: string;
  activeFrameworks: string[];
  activeLlms: Array<{
    model: string;
    provider: string;
    role: string;
    quantizationOrTier: string;
    isLocalRuntime: boolean;
  }>;
  totalLatencyMs: number;
  totalRawTokens: number;
  totalOptimizedTokens: number;
  tokenSavingsPercent: number;
  steps: AgentExecutionStep[];
}

export interface TokenOptimizationStageMetric {
  techniqueId: string;
  techniqueName: string;
  category:
    | 'Graphify (AST & Legal Graph Compression)'
    | 'Codeburn (Dead-Branch AST Pruning)'
    | 'LLMLingua-2 / Caveman (Perplexity Token Slimming)'
    | 'Anthropic / DeepSeek / Gemini Context Caching'
    | 'Semantic Chunk Dedup & Sliding Window'
    | 'Cheap-Model Routing & Speculative Decoding';
  tokensBefore: number;
  tokensAfter: number;
  reductionPercent: number;
  latencySavedMs: number;
  description: string;
  beforeSnippet: string;
  afterSnippet: string;
}

export interface TokenOptimizationBenchmarkReport {
  benchmarkId: string;
  rawContextTokens: number;
  finalCompressedTokens: number;
  totalReductionPercent: number;
  cachedPrefixHitRatePercent: number;
  estimatedCostPer1kScansRawUsd: number;
  estimatedCostPer1kScansOptimizedUsd: number;
  stages: TokenOptimizationStageMetric[];
}

export interface PromptLibraryEntry {
  id: string;
  title: string;
  agentRole: string;
  version: string;
  patternType: string;
  targetModels: string[];
  tokenOptimizationApplied: string[];
  systemPromptXml: string;
  fewShotExample: string;
  outputSchemaZodSummary: string;
}

export interface FullComplianceScanReport {
  scanId: string;
  timestamp: string;
  repositoryName: string;
  repositoryBranch: string;
  commitHash: string;
  z3EngineVersion: string;
  activeAmendmentLabel: string | null;
  totalClausesEvaluated: number;
  compliantClausesCount: number;
  violatedClausesCount: number;
  overallComplianceScore: number;
  totalZ3ExecutionMs: number;
  merkleAuditRoot: string;
  clauses: LegalClause[];
  sqlTables: SQLTableSchema[];
  astFindings: ASTFindingNode[];
  architectureGraph: {
    nodes: ArchitectureGraphNode[];
    edges: ArchitectureGraphEdge[];
  };
  proofs: ClauseVerificationProof[];
  remediationPR: RemediationPullRequest | null;
  mutationPresets: RegulatoryMutationPreset[];
  files: TargetRepoFile[];
  /** Tree-sitter matches of each clause's structural query (clause id → matches). */
  structuralQueryMatches?: Record<string, Array<{ filePath: string; language: string; line: number; captures: Record<string, string> }>>;
}
