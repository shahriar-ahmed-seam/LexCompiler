import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { runAgent } from './agentRuntime.js';
import { llmConfigFor, type LlmConfig } from './llmClient.js';
import { executeMcpTool } from '../mcp/mcpSuite.js';
import { inferRuleCategoryWithEvidence } from '../compiler/legalCompiler.js';
import type { LegalClause, LiveRegulatoryFeedItem } from '../../shared/types.js';

/**
 * The agent crew of AGENTS.md §2, chained: each agent receives what the previous one found.
 *
 *   horizon scanner → deontic extractor → AST mapper → graph RAG → Z3 critic → remediation
 *
 * What passes between agents is built from tool results only, never from model text, so a
 * model's mistake can't travel down the chain. With models on, each agent also reads what it
 * received and reports on its own tool calls; with models off (the default) every step is a
 * direct tool call and costs nothing.
 */

export type CallTool = (serverId: string, tool: string, args: Record<string, unknown>, clauses: LegalClause[]) => Promise<Record<string, unknown>>;

export interface CrewStep {
  stepNumber: number;
  agentId: string;
  agentName: string;
  /** The framework this agent uses in the Python crew (agents/lexcompiler_agents). */
  pythonAdapter: string;
  mcpServer: string;
  tool: string;
  /** What the previous agent handed over. */
  received: Record<string, unknown>;
  /** What this agent hands to the next one. */
  handoff: Record<string, unknown>;
  summary: string;
  execution: 'LLM_AGENT' | 'DIRECT_TOOL_CALL' | 'SKIPPED';
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  model?: string;
  /** The model's own report, when one ran. */
  modelReport?: { summary: string; keyFacts: string[]; confidence: number };
  /** Why the model didn't report (budget, provider error); the step's facts still come from its tools. */
  modelError?: string;
  tokens: number;
  latencyMs: number;
  error?: string;
}

/**
 * NOTHING_TO_FIX: Z3 proved every clause; PATCH_VERIFIED: the patch is SAT_COMPLIANT in the
 * sandbox (the AGENTS.md §3 gate); PATCH_BLOCKED: it isn't; INCOMPLETE: a step failed.
 */
export type CrewGate = 'NOTHING_TO_FIX' | 'PATCH_VERIFIED' | 'PATCH_BLOCKED' | 'INCOMPLETE';

export interface CrewRun {
  id: string;
  /** server: this module ran it; python: the Python crew ran it and sent it here. */
  source: 'server' | 'python';
  startedAt: string;
  finishedAt: string;
  useModels: boolean;
  status: 'COMPLETED' | 'FAILED';
  gate: CrewGate;
  totalTokens: number;
  latencyMs: number;
  triggeredBy: string | null;
  steps: CrewStep[];
}

interface Agent {
  agentId: string;
  agentName: string;
  pythonAdapter: string;
  mcpServer: string;
  tool: string;
}

export const CREW: Agent[] = [
  { agentId: 'agent-horizon-scanner', agentName: 'Regulatory horizon scanner', pythonAdapter: 'CrewAI', mcpServer: 'lex-statute-ingest-mcp', tool: 'fetch_live_regulatory_feed' },
  { agentId: 'agent-deontic-extractor', agentName: 'Deontic extractor', pythonAdapter: 'DSPy', mcpServer: 'lex-deontic-compiler-mcp', tool: 'compile_prose_to_smt_and_rego' },
  { agentId: 'agent-polyglot-ast-mapper', agentName: 'Polyglot AST mapper', pythonAdapter: 'Hermes-style tool calls (Ollama)', mcpServer: 'lex-polyglot-ast-mcp', tool: 'scan_polyglot_repository_ast' },
  { agentId: 'agent-contextual-graph-rag', agentName: 'Contextual graph RAG', pythonAdapter: 'LangGraph', mcpServer: 'lex-hybrid-rag-mcp', tool: 'hybrid_contextual_graph_rag_query' },
  { agentId: 'agent-z3-formal-critic', agentName: 'Z3 formal critic', pythonAdapter: 'Pydantic-AI', mcpServer: 'lex-z3-prover-mcp', tool: 'prove_repository_compliance_z3' },
  { agentId: 'agent-remediation-pr-enforcer', agentName: 'Remediation and PR gate', pythonAdapter: 'OpenAI Agents SDK', mcpServer: 'lex-remediation-pr-mcp', tool: 'synthesize_and_verify_remediation_pr' },
];

const MAX_FEED_ITEMS = 5;
const MAX_LOCATIONS = 10;

interface StepWork {
  /** Runs the step's tools and returns the handoff and a one-line summary of the facts. */
  run: () => Promise<{ handoff: Record<string, unknown>; summary: string }>;
  /** The tool arguments the model is told about. */
  args: Record<string, unknown>;
}

export async function runCrew(
  clauses: LegalClause[],
  opts: { useModels?: boolean; callTool?: CallTool; triggeredBy?: string | null; llmFor?: (agentId: string) => LlmConfig | null } = {}
): Promise<CrewRun> {
  const useModels = opts.useModels ?? false;
  const callTool = opts.callTool ?? executeMcpTool;
  const llmFor = opts.llmFor ?? ((id: string) => llmConfigFor(id));
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const steps: CrewStep[] = [];
  const agent = (i: number) => CREW[i];

  // The clauses this run checks, as the deontic extractor compiled them (set by step 2).
  let crewClauses: LegalClause[] = clauses;
  let received: Record<string, unknown> = { activeClauses: clauses.map((c) => ({ id: c.id, citation: c.citation, category: c.category })) };

  const work: Array<(r: Record<string, unknown>) => StepWork | null> = [
    // 1. Horizon scanner: which new regulatory items bear on the active rules.
    () => ({
      args: { jurisdiction: 'ALL' },
      run: async () => {
        const out = await callTool(agent(0).mcpServer, agent(0).tool, { jurisdiction: 'ALL' }, clauses);
        const items = ((out.items as LiveRegulatoryFeedItem[] | undefined) || []).map((i) => ({ id: i.id, title: i.title, url: i.url, category: inferRuleCategoryWithEvidence(`${i.title}
${i.excerpt || ''}`) }));
        const categories = new Set(clauses.map((c) => c.category));
        // An item with no category evidence matches nothing (the plain inference would default to retention).
        const relevant = items.filter((i) => i.category && categories.has(i.category)).slice(0, MAX_FEED_ITEMS);
        const touched = clauses.filter((c) => relevant.some((i) => i.category === c.category));
        // With no matching item the crew still checks every active rule.
        const selected = touched.length ? touched : clauses;
        return {
          handoff: { feedItems: relevant, clauseIds: selected.map((c) => c.id), reason: touched.length ? 'feed items match these rules' : 'no feed item matches a rule; checking all active rules' },
          summary: `Read ${items.length} feed items; ${relevant.length} match the categories of ${touched.length} active rule(s).${touched.length ? '' : ' Checking all active rules.'}`,
        };
      },
    }),
    // 2. Deontic extractor: compile the selected rules' text; later steps use what it compiled.
    (r) => {
      const ids = new Set((r.clauseIds as string[] | undefined) || []);
      const selected = clauses.filter((c) => ids.has(c.id));
      return {
        args: { clauses: selected.map((c) => ({ rawLegalText: c.rawLegalText, category: c.category, citation: c.citation })) },
        run: async () => {
          const compiled: LegalClause[] = [];
          for (const c of selected) {
            const out = (await callTool(agent(1).mcpServer, agent(1).tool, { rawLegalText: c.rawLegalText, category: c.category, citation: c.citation }, clauses)) as Pick<LegalClause, 'deontic' | 'compiled'>;
            compiled.push({ ...c, deontic: out.deontic, compiled: out.compiled });
          }
          crewClauses = compiled;
          const rules = compiled.map((c) => ({ id: c.id, citation: c.citation, category: c.category, formula: c.deontic?.formalPredicateSummary || '' }));
          return { handoff: { rules }, summary: `Compiled ${compiled.length} rule(s) to deontic logic, SMT-LIB2 and Rego.` };
        },
      };
    },
    // 3. AST mapper: where in the code each compiled rule's pattern matches.
    () => ({
      args: { includeMetrics: true },
      run: async () => {
        const out = await callTool(agent(2).mcpServer, agent(2).tool, { includeMetrics: true }, crewClauses);
        const matches = (out.structuralQueryMatches || {}) as Record<string, Array<{ filePath: string; line: number }>>;
        const locations = Object.fromEntries(crewClauses.map((c) => [c.id, (matches[c.id] || []).slice(0, MAX_LOCATIONS).map((m) => `${m.filePath}:${m.line}`)]));
        const count = Object.values(locations).reduce((n, l) => n + l.length, 0);
        return {
          handoff: { locations, filesScanned: out.filesScanned ?? 0 },
          summary: `Scanned ${String(out.filesScanned ?? 0)} files; the rules' patterns match ${count} location(s).`,
        };
      },
    }),
    // 4. Graph RAG: ground the rules in the code, starting from the mapper's locations.
    (r) => {
      const rules = (steps[1]?.handoff.rules as Array<{ citation: string; formula: string }> | undefined) || [];
      const locs = Object.values((r.locations || {}) as Record<string, string[]>).flat().slice(0, 8);
      const query = `Which code violates ${rules.map((x) => `${x.citation}${x.formula ? ` (${x.formula})` : ''}`).join('; ') || 'the active rules'}?${locs.length ? ` Candidate locations: ${locs.join(', ')}.` : ''}`;
      return {
        args: { query, topK: 4 },
        run: async () => {
          const out = await callTool(agent(3).mcpServer, agent(3).tool, { query, topK: 4 }, crewClauses);
          const chunks = (out.retrievedChunks as Array<{ chunk: { citationOrPath: string; sourceType: string } }> | undefined) || [];
          const sources = [...new Set(chunks.map((c) => c.chunk.citationOrPath))];
          return { handoff: { query, sources }, summary: `Retrieved ${chunks.length} chunk(s) from ${sources.length} source(s) for the rules.` };
        },
      };
    },
    // 5. Z3 critic: prove the compiled rules against the code.
    () => ({
      args: { extractUnsatCore: true },
      run: async () => {
        const out = await callTool(agent(4).mcpServer, agent(4).tool, { extractUnsatCore: true }, crewClauses);
        const verdicts = (out.verdicts as Array<{ clauseId: string; citation: string; status: string; unsatCore: string[]; offendingLocations: Array<{ filePath: string; line: number }> }> | undefined) || [];
        const unsat = verdicts.filter((v) => v.status === 'UNSAT_VIOLATION');
        return {
          handoff: {
            unsat: unsat.map((v) => ({ clauseId: v.clauseId, citation: v.citation, unsatCore: v.unsatCore, locations: v.offendingLocations.slice(0, MAX_LOCATIONS).map((l) => `${l.filePath}:${l.line}`) })),
            satClauseIds: verdicts.filter((v) => v.status === 'SAT_COMPLIANT').map((v) => v.clauseId),
            merkleAuditRoot: out.merkleAuditRoot,
          },
          summary: `Z3 checked ${verdicts.length} rule(s): ${unsat.length} UNSAT with unsat cores, ${verdicts.length - unsat.length} not violated.`,
        };
      },
    }),
    // 6. Remediation: only for what Z3 refuted; the patch must be SAT_COMPLIANT to pass the gate.
    (r) => {
      const unsatIds = new Set(((r.unsat as Array<{ clauseId: string }> | undefined) || []).map((u) => u.clauseId));
      if (!unsatIds.size) return null;
      return {
        args: { branchPrefix: 'lexcompiler/crew' },
        run: async () => {
          const toFix = crewClauses.filter((c) => unsatIds.has(c.id));
          const out = await callTool(agent(5).mcpServer, agent(5).tool, { branchPrefix: 'lexcompiler/crew' }, toFix);
          const files = ((out.filePatches as Array<{ filePath: string }> | undefined) || []).map((p) => p.filePath);
          const verified = out.postPatchZ3Status === 'SAT_COMPLIANT';
          return {
            handoff: { status: out.status, postPatchZ3Status: out.postPatchZ3Status ?? null, branchName: out.branchName ?? null, files, gatePassed: verified, clauseIds: toFix.map((c) => c.id) },
            summary: files.length
              ? `Patched ${files.length} file(s) for ${toFix.length} rule(s); post-patch Z3 ${String(out.postPatchZ3Status)}${verified ? ', so the patch passes the gate' : ', so the gate blocks it'}.`
              : `No patch could be synthesized (${String(out.status)}).`,
          };
        },
      };
    },
  ];

  let failed = false;
  for (const [i, make] of work.entries()) {
    const a = agent(i);
    const base = { stepNumber: i + 1, agentId: a.agentId, agentName: a.agentName, pythonAdapter: a.pythonAdapter, mcpServer: a.mcpServer, tool: a.tool, received };
    if (failed) {
      steps.push({ ...base, handoff: {}, summary: 'Not run: an earlier step failed.', execution: 'SKIPPED', status: 'SKIPPED', tokens: 0, latencyMs: 0 });
      continue;
    }
    const w = make(received);
    if (!w) {
      steps.push({ ...base, handoff: {}, summary: 'Nothing to fix: Z3 refuted no rule.', execution: 'SKIPPED', status: 'SKIPPED', tokens: 0, latencyMs: 0 });
      continue;
    }
    const s0 = performance.now();
    try {
      const { handoff, summary } = await w.run();
      const step: CrewStep = { ...base, handoff, summary, execution: 'DIRECT_TOOL_CALL', status: 'COMPLETED', tokens: 0, latencyMs: 0 };
      const llm = useModels ? llmFor(a.agentId) : null;
      if (llm) {
        step.execution = 'LLM_AGENT';
        step.model = llm.label || llm.model;
        try {
          const run = await runAgent({
            agentId: a.agentId,
            role: `You are the ${a.agentName} agent of LexCompiler, one of six agents in a chain.`,
            task: [
              `The previous agent handed you:\n${JSON.stringify(received).slice(0, 3000)}`,
              `Call ${a.tool} with ${JSON.stringify(w.args).slice(0, 1500)} and report what you found for the next agent.`,
            ].join('\n\n'),
            mcpServerId: a.mcpServer,
            clauses: i === 0 ? clauses : crewClauses,
            llm,
            maxTurns: 4,
          });
          step.modelReport = run.output;
          step.tokens = run.usage.promptTokens + run.usage.completionTokens;
        } catch (err) {
          step.modelError = err instanceof Error ? err.message : String(err);
        }
      }
      step.latencyMs = Math.round(performance.now() - s0);
      steps.push(step);
      received = handoff;
    } catch (err) {
      failed = true;
      steps.push({ ...base, handoff: {}, summary: 'The step failed.', error: err instanceof Error ? err.message : String(err), execution: 'DIRECT_TOOL_CALL', status: 'FAILED', tokens: 0, latencyMs: Math.round(performance.now() - s0) });
    }
  }

  const last = steps[5];
  const gate: CrewGate = failed ? 'INCOMPLETE' : last.status === 'SKIPPED' ? 'NOTHING_TO_FIX' : last.handoff.gatePassed ? 'PATCH_VERIFIED' : 'PATCH_BLOCKED';
  return {
    id: crypto.randomUUID(),
    source: 'server',
    startedAt,
    finishedAt: new Date().toISOString(),
    useModels,
    status: failed ? 'FAILED' : 'COMPLETED',
    gate,
    totalTokens: steps.reduce((n, s) => n + s.tokens, 0),
    latencyMs: Math.round(performance.now() - t0),
    triggeredBy: opts.triggeredBy ?? null,
    steps,
  };
}

/** Stored crew runs (migration 12). */
export class CrewRunStore {
  constructor(private readonly db: DatabaseSync) {}

  save(run: CrewRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_crew_runs (id, source, started_at, finished_at, use_models, status, gate, total_tokens, latency_ms, triggered_by, run_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(run.id, run.source, run.startedAt, run.finishedAt, run.useModels ? 1 : 0, run.status, run.gate, run.totalTokens, run.latencyMs, run.triggeredBy, JSON.stringify(run));
  }

  get(id: string): CrewRun | null {
    const row = this.db.prepare('SELECT run_json FROM agent_crew_runs WHERE id = ?').get(id) as { run_json: string } | undefined;
    return row ? (JSON.parse(row.run_json) as CrewRun) : null;
  }

  /** Newest first, without the steps. */
  list(limit = 20): Array<Omit<CrewRun, 'steps'> & { stepStatuses: string[] }> {
    const rows = this.db.prepare('SELECT run_json FROM agent_crew_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Array<{ run_json: string }>;
    return rows.map((r) => {
      const { steps, ...rest } = JSON.parse(r.run_json) as CrewRun;
      return { ...rest, stepStatuses: steps.map((s) => s.status) };
    });
  }
}

/**
 * Builds the stored run from what the Python crew sent (already validated): each step gets the
 * agent's details from CREW, and its tokens from the server's own call log (ai_calls, task = the
 * agent id, between the run's start and end), since the agents' model calls went through the
 * server's agent route.
 */
export function importedRun(db: DatabaseSync, body: Record<string, unknown>, triggeredBy: string | null): CrewRun {
  const now = new Date().toISOString();
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : now);
  const startedAt = iso(body.startedAt);
  const finishedAt = iso(body.finishedAt);
  const tokensFor = db.prepare(
    "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_calls WHERE task = ? AND created_at >= ? AND created_at <= ?"
  );
  const text = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const object = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const steps: CrewStep[] = (body.steps as Array<Record<string, unknown>>).map((s, i) => {
    const a = CREW[i];
    const status = s.status as CrewStep['status'];
    return {
      stepNumber: i + 1,
      agentId: a.agentId,
      agentName: a.agentName,
      pythonAdapter: a.pythonAdapter,
      mcpServer: a.mcpServer,
      tool: a.tool,
      received: object(s.received),
      handoff: object(s.handoff),
      summary: text(s.summary),
      execution: status === 'SKIPPED' ? 'SKIPPED' : 'LLM_AGENT',
      status,
      ...(s.error ? { error: text(s.error, 500) } : {}),
      tokens: status === 'SKIPPED' ? 0 : Number((tokensFor.get(a.agentId, startedAt, finishedAt) as { n: number }).n),
      latencyMs: Math.max(0, Math.round(Number(s.latencyMs) || 0)),
    };
  });
  const failed = steps.some((s) => s.status === 'FAILED');
  const gates: CrewGate[] = ['NOTHING_TO_FIX', 'PATCH_VERIFIED', 'PATCH_BLOCKED', 'INCOMPLETE'];
  return {
    id: crypto.randomUUID(),
    source: 'python',
    startedAt,
    finishedAt,
    useModels: true,
    status: failed ? 'FAILED' : 'COMPLETED',
    gate: failed ? 'INCOMPLETE' : (gates.find((g) => g === body.gate) ?? 'INCOMPLETE'),
    totalTokens: steps.reduce((n, s) => n + s.tokens, 0),
    latencyMs: Math.max(0, Math.round(Number(body.latencyMs) || 0)),
    triggeredBy,
    steps,
  };
}

/**
 * Checks a run sent by the Python crew: six steps in crew order. Returns an error message or null.
 * The Python crew runs on the operator's machine; its runs are stored as it reports them.
 */
export function validateImportedRun(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'the body must be a JSON object';
  const steps = (body as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length !== CREW.length) return `"steps" must list the ${CREW.length} agents`;
  for (const [i, s] of steps.entries()) {
    if (!s || typeof s !== 'object' || (s as { agentId?: unknown }).agentId !== CREW[i].agentId) return `step ${i + 1} must be ${CREW[i].agentId}`;
    if (!['COMPLETED', 'FAILED', 'SKIPPED'].includes(String((s as { status?: unknown }).status))) return `step ${i + 1} needs a status of COMPLETED, FAILED or SKIPPED`;
  }
  return null;
}
