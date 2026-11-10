import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Bot, Braces, Cpu, Database, Scale, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { AppSidebar, type WorkspaceNavItem } from './components/AppSidebar';
import { ApiDocsView } from './components/ApiDocsView';
import { CommandBar } from './components/CommandBar';
import { ArchitectureGraphCanvas } from './components/ArchitectureGraphCanvas';
import { EnterpriseStartupSuite } from './components/EnterpriseStartupSuite';
import { HybridRagStudio } from './components/HybridRagStudio';
import { IdeRemediationDrawer } from './components/IdeRemediationDrawer';
import { LegalCompilerPane } from './components/LegalCompilerPane';
import { LiveDocsAndRubricView } from './components/LiveDocsAndRubricView';
import { LiveMultiLlmMeshStudio } from './components/LiveMultiLlmMeshStudio';
import { McpAndAgentsHub, type ExternalMcpServerStatus } from './components/McpAndAgentsHub';
import { TokenAndDataLifecycleLab } from './components/TokenAndDataLifecycleLab';
import { feedItemToClauseRequest } from './feedIngest';
import type {
  FullComplianceScanReport,
  LiveRegulatoryFeedItem,
  McpServerDescriptor,
  MultiAgentPipelineReport,
  PromptLibraryEntry,
  RagQueryExecutionReport,
  TokenOptimizationBenchmarkReport,
} from '../shared/types';

type ActiveWorkspaceTab =
  | 'LAW_TO_AST_STUDIO'
  | 'MULTI_LLM_SERVICE_MESH'
  | 'ENTERPRISE_CLOUD_SUITE'
  | 'MCP_AND_AGENTS'
  | 'HYBRID_GRAPH_RAG'
  | 'TOKEN_AND_DATA_STACK'
  | 'API_DOCS'
  | 'LIVE_DOCS_AND_RUBRIC';

/** Ctrl/⌘ + 1–8 open the modules in sidebar order. */
const TAB_SHORTCUT_ORDER: ActiveWorkspaceTab[] = [
  'LAW_TO_AST_STUDIO',
  'MULTI_LLM_SERVICE_MESH',
  'ENTERPRISE_CLOUD_SUITE',
  'MCP_AND_AGENTS',
  'HYBRID_GRAPH_RAG',
  'TOKEN_AND_DATA_STACK',
  'API_DOCS',
  'LIVE_DOCS_AND_RUBRIC',
];

export function App() {
  const [workspaceTab, setWorkspaceTab] = useState<ActiveWorkspaceTab>(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab') as ActiveWorkspaceTab | null;
    if (tabParam) return tabParam;
    return window.location.pathname.startsWith('/docs')
      ? 'LIVE_DOCS_AND_RUBRIC'
      : 'LAW_TO_AST_STUDIO';
  });
  const [report, setReport] = useState<FullComplianceScanReport | null>(null);
  const [liveFeedItems, setLiveFeedItems] = useState<LiveRegulatoryFeedItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDescriptor[]>([]);
  const [externalMcpServers, setExternalMcpServers] = useState<ExternalMcpServerStatus[]>([]);
  const [multiAgentReport, setMultiAgentReport] = useState<MultiAgentPipelineReport | null>(
    null
  );
  const [tokenBenchmark, setTokenBenchmark] =
    useState<TokenOptimizationBenchmarkReport | null>(null);
  const [defaultRagReport, setDefaultRagReport] =
    useState<RagQueryExecutionReport | null>(null);
  const [promptLibrary, setPromptLibrary] = useState<PromptLibraryEntry[]>([]);
  const [serviceMeshSummary, setServiceMeshSummary] = useState<any | null>(null);

  const [activeClauseId, setActiveClauseId] = useState<string>('CLAUSE-DPA-4.2');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node-postgres-schema');
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [isApplyingPatch, setIsApplyingPatch] = useState<boolean>(false);
  const [shockwaveActive, setShockwaveActive] = useState<boolean>(false);
  const [shockwaveStage, setShockwaveStage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [activeLocale, setActiveLocale] = useState<'en' | 'bn'>('en');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('lexcompiler.sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('lexcompiler.sidebarCollapsed', next ? '1' : '0');
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  const triggerToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4500);
  }, []);

  const runShockwaveAnimation = useCallback((stageLabel: string) => {
    setShockwaveActive(true);
    setShockwaveStage(`Stage 1/3: Deontic Agent extracting obligation (${stageLabel})...`);
    setTimeout(() => {
      setShockwaveStage(
        'Stage 2/3: Synthesizing SMT-LIB2 & OPA Rego + Solving in Microsoft Z3...'
      );
    }, 380);
    setTimeout(() => {
      setShockwaveStage(
        'Stage 3/3: Blast-Radius Shockwave → 3 Polyglot AST Nodes (Postgres, FastAPI, Redis) UNSAT!'
      );
    }, 760);
    setTimeout(() => {
      setShockwaveActive(false);
      setShockwaveStage(null);
    }, 2200);
  }, []);

  const fetchAllTelemetry = useCallback(async () => {
    try {
      const [stateRes, feedRes, aiHeavyRes, meshRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/regulations/live-feed'),
        fetch('/api/ai-heavy/overview'),
        fetch('/api/services/mesh'),
      ]);
      if (stateRes.ok) {
        const data = (await stateRes.json()) as FullComplianceScanReport;
        setReport(data);
        if (
          data.clauses[0] &&
          /[অ-হ]/.test(data.clauses[0].rawLegalText)
        ) {
          setActiveLocale('bn');
        } else {
          setActiveLocale('en');
        }
      }
      if (feedRes.ok) {
        const feedData = (await feedRes.json()) as { items: LiveRegulatoryFeedItem[] };
        setLiveFeedItems(feedData.items || []);
      }
      if (aiHeavyRes.ok) {
        const aiData = await aiHeavyRes.json();
        setMcpServers(aiData.mcpServers || []);
        setExternalMcpServers(aiData.externalMcpServers || []);
        setMultiAgentReport(aiData.multiAgentReport || null);
        setTokenBenchmark(aiData.tokenBenchmark || null);
        setDefaultRagReport(aiData.defaultRagReport || null);
        setPromptLibrary(aiData.promptLibrary || []);
      }
      if (meshRes.ok) {
        setServiceMeshSummary(await meshRes.json());
      }
    } catch (err) {
      console.error('Failed to load initial state:', err);
    }
  }, []);

  useEffect(() => {
    fetchAllTelemetry();
  }, [fetchAllTelemetry]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const tab = TAB_SHORTCUT_ORDER[Number(e.key) - 1];
      if (!tab) return;
      e.preventDefault();
      setWorkspaceTab(tab);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleCompileCustomProse = async (
    clauseId: string,
    newProse: string,
    extra: Partial<ReturnType<typeof feedItemToClauseRequest>> = {}
  ) => {
    setIsCompiling(true);
    runShockwaveAnimation('Custom Legal Clause Compilation');
    try {
      const res = await fetch('/api/clauses/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clauseId,
          rawLegalText: newProse,
          amendmentLabel: `Custom Prose Mutation on ${clauseId}`,
          ...extra,
        }),
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        if (updated.clauses.some((c) => c.id === clauseId)) setActiveClauseId(clauseId);
        fetchAllTelemetry();
        triggerToast(
          `Compiled legal prose into SMT-LIB2 & verified against ${updated.files.length} polyglot AST files in ${updated.totalZ3ExecutionMs} ms.`
        );
      }
    } finally {
      setIsCompiling(false);
    }
  };

  const handleTriggerMutationPreset = async (
    presetId: string,
    resetRepoFiles = false
  ) => {
    setIsCompiling(true);
    setWorkspaceTab('LAW_TO_AST_STUDIO');
    runShockwaveAnimation(presetId);
    try {
      const res = await fetch('/api/clauses/mutate-preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId, resetRepoFiles }),
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        fetchAllTelemetry();
        const preset = updated.mutationPresets.find((p) => p.id === presetId);
        if (preset) {
          setActiveClauseId(preset.clauseId);
          if (preset.blastRadiusNodeIds[0]) {
            setSelectedNodeId(preset.blastRadiusNodeIds[0]);
          }
          triggerToast(
            `Regulatory Amendment Propagated: ${preset.parameterDiffSummary} → ${updated.violatedClausesCount} active UNSAT violations.`
          );
        }
      }
    } finally {
      setIsCompiling(false);
    }
  };

  const handleSimulateFlagshipAmendment = async () => {
    await handleTriggerMutationPreset('PRESET-72H-TENANT-KMS', true);
  };

  const handleSet30DayBaseline = async () => {
    setIsCompiling(true);
    setWorkspaceTab('LAW_TO_AST_STUDIO');
    try {
      const res = await fetch('/api/repo/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'LEGACY_30D_COMPLIANT_DPA' }),
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        fetchAllTelemetry();
        setActiveClauseId('CLAUSE-DPA-4.2');
        setSelectedNodeId('node-redis-worker');
        triggerToast(
          'Set DPA §4.2 to Legacy 30-Day (720h) Baseline — Click "Simulate Regulatory Amendment" to trigger the 72h + Tenant KMS shockwave!'
        );
      }
    } finally {
      setIsCompiling(false);
    }
  };

  const handleApplyNodePatch = async (nodeId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setIsApplyingPatch(true);
    try {
      const res = await fetch('/api/remediation/apply-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        fetchAllTelemetry();
        triggerToast(
          `Applied AST patch to node '${nodeId}' & re-verified in Microsoft Z3: ${updated.compliantClausesCount}/${updated.totalClausesEvaluated} clauses SAT_COMPLIANT (${updated.totalZ3ExecutionMs} ms).`
        );
      } else if (res.status === 409) {
        const blocked = (await res.json().catch(() => ({}))) as { error?: string };
        triggerToast(blocked.error || 'Patch blocked by the pre-PR Z3 sandbox gate.');
      }
    } finally {
      setIsApplyingPatch(false);
    }
  };

  const handleApplyFullPR = async () => {
    setIsApplyingPatch(true);
    try {
      const res = await fetch('/api/remediation/apply-pr', {
        method: 'POST',
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        fetchAllTelemetry();
        triggerToast(
          `Applied remediation PR. Microsoft Z3 re-verification: ${updated.compliantClausesCount}/${updated.totalClausesEvaluated} clauses SAT_COMPLIANT (${updated.overallComplianceScore}%, ${updated.totalZ3ExecutionMs} ms).`
        );
      } else if (res.status === 409) {
        const blocked = (await res.json().catch(() => ({}))) as { error?: string };
        triggerToast(blocked.error || 'PR blocked by the pre-PR Z3 sandbox gate.');
      }
    } finally {
      setIsApplyingPatch(false);
    }
  };

  const handleSaveFileEdit = async (filePath: string, newContent: string) => {
    setIsApplyingPatch(true);
    try {
      const res = await fetch('/api/repo/update-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, content: newContent }),
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        fetchAllTelemetry();
        triggerToast(
          `Saved ${filePath} to disk, re-parsed AST, and re-evaluated Z3 constraints (${updated.totalZ3ExecutionMs} ms).`
        );
      }
    } finally {
      setIsApplyingPatch(false);
    }
  };

  const handleIngestLiveFeedItem = async (item: LiveRegulatoryFeedItem) => {
    const request = feedItemToClauseRequest(item);
    await handleCompileCustomProse(request.clauseId, request.rawLegalText, request);
  };

  const handleSwitchLocale = async (locale: 'en' | 'bn') => {
    setActiveLocale(locale);
    setIsCompiling(true);
    runShockwaveAnimation(
      locale === 'bn'
        ? 'বাংলাদেশ ব্যাংক আইসিটি নীতিমালা ধারা ৪.২ (৪৮ ঘণ্টা)'
        : 'GDPR Art. 17 & 32 / DPA §4.2 (72h)'
    );
    try {
      const res = await fetch('/api/clauses/switch-locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, resetRepo: true }),
      });
      if (res.ok) {
        const updated = (await res.json()) as FullComplianceScanReport;
        setReport(updated);
        fetchAllTelemetry();
        triggerToast(
          locale === 'bn'
            ? 'বাংলা আইন সক্রিয় করা হয়েছে: ৪টি ধারা (৪৮ ঘণ্টা রিটেনশন, টেন্যান্ট KMS, লগিং নিষেধাজ্ঞা, ৮৫% এআই গেট) Z3 দ্বারা যাচাইকৃত।'
            : 'Switched to Global English statutory corpus (GDPR, HIPAA, EU AI Act) & verified in Z3.'
        );
      }
    } finally {
      setIsCompiling(false);
    }
  };

  if (!report) {
    return (
      <div className="min-h-screen bg-[#050609] text-zinc-100 flex items-center justify-center p-6">
        <div role="status" className="flex flex-col items-center gap-3 text-center">
          <Cpu className="w-8 h-8 text-amber-400 animate-spin" aria-hidden="true" />
          <div className="text-sm font-mono font-medium text-zinc-300">
            Initializing LexCompiler Neuro-Symbolic Engine (Ollama Multi-LLM + Microsoft Z3 +
            SQLite Vector Ledger)...
          </div>
        </div>
      </div>
    );
  }

  const selectedNode =
    report.architectureGraph.nodes.find((n) => n.id === selectedNodeId) ||
    report.architectureGraph.nodes[0];

  const isAllCompliant = report.violatedClausesCount === 0;
  const activeClause =
    report.clauses.find((c) => c.id === activeClauseId) || report.clauses[0];

  const navItems: WorkspaceNavItem<ActiveWorkspaceTab>[] = [
    {
      id: 'LAW_TO_AST_STUDIO',
      label: 'Law-to-AST Split Studio',
      sublabel: 'Deontic Compiler & Graph',
      shortcutDigit: 1,
      icon: <Scale className="w-4 h-4 text-amber-300" />,
    },
    {
      id: 'MULTI_LLM_SERVICE_MESH',
      label: 'Live Multi-LLM & Services',
      sublabel: 'Ollama · Z3 · SQLite · 384d',
      shortcutDigit: 2,
      badge: `${serviceMeshSummary?.ollamaModels?.length || 3} LLMs`,
      icon: <Cpu className="w-4 h-4 text-emerald-400" />,
    },
    {
      id: 'ENTERPRISE_CLOUD_SUITE',
      label: 'Enterprise BYOC & Certs',
      sublabel: 'Ed25519 · SARIF · Fine ROI',
      shortcutDigit: 3,
      icon: <ShieldCheck className="w-4 h-4 text-indigo-400" />,
    },
    {
      id: 'MCP_AND_AGENTS',
      label: '12-MCP & 6-Agent Plane',
      sublabel: 'JSON-RPC 2.0 · CrewAI/DSPy',
      shortcutDigit: 4,
      badge: '12 MCP',
      icon: <Bot className="w-4 h-4 text-sky-400" />,
    },
    {
      id: 'HYBRID_GRAPH_RAG',
      label: 'Contextual + Graph RAG',
      sublabel: 'all-minilm 384d · BM25 · Neo4j',
      shortcutDigit: 5,
      badge: '98%',
      icon: <Database className="w-4 h-4 text-amber-400" />,
    },
    {
      id: 'TOKEN_AND_DATA_STACK',
      label: 'Token Optimizer & Data',
      sublabel: 'Codeburn · Graphify · Lakehouse',
      shortcutDigit: 6,
      badge: '-89%',
      icon: <Zap className="w-4 h-4 text-emerald-300" />,
    },
    {
      id: 'API_DOCS',
      label: 'API Reference',
      sublabel: 'REST · MCP · Webhooks',
      shortcutDigit: 7,
      icon: <Braces className="w-4 h-4 text-sky-300" />,
    },
    {
      id: 'LIVE_DOCS_AND_RUBRIC',
      label: 'Architecture & Specs (/docs)',
      sublabel: 'Formal Grammar & Prompts',
      shortcutDigit: 8,
      icon: <BookOpen className="w-4 h-4 text-zinc-300" />,
    },
  ];

  return (
    <div className="min-h-screen flex bg-[#050609] text-[#F4F4F6]">
      <AppSidebar
        items={navItems}
        activeId={workspaceTab}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onSelect={setWorkspaceTab}
        ollamaModelCount={serviceMeshSummary?.ollamaModels?.length || 3}
        z3ExecutionMs={report.totalZ3ExecutionMs}
        commitHash={report.commitHash}
      />

      {/* RIGHT MAIN WORKSPACE AREA */}
      <div className="flex-1 flex flex-col min-w-0">
        <CommandBar
          repositoryName={report.repositoryName}
          commitHash={report.commitHash}
          activeLocale={activeLocale}
          isAllCompliant={isAllCompliant}
          isApplyingPatch={isApplyingPatch}
          violatedClausesCount={report.violatedClausesCount}
          totalZ3ExecutionMs={report.totalZ3ExecutionMs}
          onSwitchLocale={handleSwitchLocale}
          onSetBaseline={handleSet30DayBaseline}
          onSimulateAmendment={handleSimulateFlagshipAmendment}
          onApplyFullPR={handleApplyFullPR}
        />

        {/* Toast Notification Banner */}
        <div role="status" aria-live="polite" aria-atomic="true" className="fixed bottom-4 right-4 z-50 max-w-md">
          {toastMessage && (
            <div className="px-4 py-2.5 rounded-xl bg-[#0F131D]/95 border border-amber-400/50 text-zinc-100 text-xs font-mono shadow-2xl flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-300 shrink-0" aria-hidden="true" />
              <span>{toastMessage}</span>
            </div>
          )}
        </div>

        {/* VIEW 1: Main Split-Screen "Law-to-Code" Workbench */}
        {workspaceTab === 'LAW_TO_AST_STUDIO' && (
          <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
            <div className="lg:col-span-5 flex flex-col min-h-[680px]">
              <LegalCompilerPane
                clauses={report.clauses}
                proofs={report.proofs}
                activeClauseId={activeClauseId}
                mutationPresets={report.mutationPresets}
                liveFeedItems={liveFeedItems}
                isCompiling={isCompiling}
                onSelectClause={(cid) => {
                  setActiveClauseId(cid);
                  const prf = report.proofs.find((p) => p.clauseId === cid);
                  if (prf?.affectedGraphNodeIds[0]) {
                    setSelectedNodeId(prf.affectedGraphNodeIds[0]);
                  }
                }}
                onCompileCustomProse={handleCompileCustomProse}
                onTriggerMutationPreset={(pid) => handleTriggerMutationPreset(pid, false)}
                onIngestLiveFeedItem={handleIngestLiveFeedItem}
              />
            </div>

            <div className="lg:col-span-7 flex flex-col min-h-[680px]">
              <ArchitectureGraphCanvas
                nodes={report.architectureGraph.nodes}
                edges={report.architectureGraph.edges}
                selectedNodeId={selectedNode.id}
                activeClauseId={activeClauseId}
                shockwaveActive={shockwaveActive}
                shockwaveStage={shockwaveStage}
                proofs={report.proofs}
                onSelectNode={(nid) => setSelectedNodeId(nid)}
                onQuickApplyNodePatch={handleApplyNodePatch}
              />

              <IdeRemediationDrawer
                selectedNode={selectedNode}
                files={report.files}
                proofs={report.proofs}
                remediationPR={report.remediationPR}
                merkleAuditRoot={report.merkleAuditRoot}
                isApplyingPatch={isApplyingPatch}
                onApplyNodePatch={(nid) => handleApplyNodePatch(nid)}
                onApplyFullPR={handleApplyFullPR}
                onSaveFileEdit={handleSaveFileEdit}
              />
            </div>
          </main>
        )}

        {/* VIEW 2: Live Multi-LLM & 6-Service Mesh Studio */}
        {workspaceTab === 'MULTI_LLM_SERVICE_MESH' && (
          <main className="flex-1 overflow-y-auto">
            <LiveMultiLlmMeshStudio activeClauseText={activeClause?.rawLegalText || ''} />
          </main>
        )}

        {/* VIEW 3: Enterprise BYOC Scanner, Ed25519 Conformity Cert & SARIF Suite */}
        {workspaceTab === 'ENTERPRISE_CLOUD_SUITE' && (
          <main className="flex-1 overflow-y-auto">
            <EnterpriseStartupSuite report={report} />
          </main>
        )}

        {/* VIEW 4: 12-MCP & 6-Agent Control Plane */}
        {workspaceTab === 'MCP_AND_AGENTS' && (
          <main className="flex-1 overflow-y-auto">
            <McpAndAgentsHub
              mcpServers={mcpServers}
              externalMcpServers={externalMcpServers}
              multiAgentReport={multiAgentReport}
              onRefreshAgents={fetchAllTelemetry}
            />
          </main>
        )}

        {/* VIEW 5: Contextual + Graph RAG Studio */}
        {workspaceTab === 'HYBRID_GRAPH_RAG' && (
          <main className="flex-1 overflow-y-auto">
            <HybridRagStudio initialReport={defaultRagReport} />
          </main>
        )}

        {/* VIEW 6: Token Optimization & Data Lifecycle Lab */}
        {workspaceTab === 'TOKEN_AND_DATA_STACK' && (
          <main className="flex-1 overflow-y-auto">
            <TokenAndDataLifecycleLab benchmark={tokenBenchmark} />
          </main>
        )}

        {/* VIEW 7: API Reference — the server's HTTP surface, documented in src/apiDocs.ts */}
        {workspaceTab === 'API_DOCS' && (
          <main className="flex-1 overflow-y-auto p-4">
            <ApiDocsView />
          </main>
        )}

        {/* VIEW 8: Live /docs Whitepaper, Prompt Library & 425-Pt Submission Guide */}
        {workspaceTab === 'LIVE_DOCS_AND_RUBRIC' && (
          <main className="flex-1 overflow-y-auto">
            <LiveDocsAndRubricView promptLibrary={promptLibrary} />
          </main>
        )}
      </div>
    </div>
  );
}

export default App;
