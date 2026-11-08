import React, { useState } from 'react';
import {
  Bot,
  Cpu,
  Network,
  Play,
  Radio,
  Server,
  Terminal,
  Zap,
} from 'lucide-react';
import { LabCrewRuns } from './LabCrewRuns';
import type {
  McpServerDescriptor,
  McpToolInvocationResult,
  MultiAgentPipelineReport,
} from '../../shared/types';

/** An external MCP server from /api/ai-heavy/overview: suggested ones stay NOT_CONFIGURED until they answer. */
export interface ExternalMcpServerStatus {
  id: string;
  name: string;
  transport: string;
  purpose: string;
  status: string;
  liveTools?: Array<{ name: string }>;
  error?: string;
}

interface McpAndAgentsHubProps {
  mcpServers: McpServerDescriptor[];
  externalMcpServers?: ExternalMcpServerStatus[];
  multiAgentReport: MultiAgentPipelineReport | null;
  onRefreshAgents: () => void;
}

const RUNTIME_LABEL = { cloud: 'Cloud model', local: 'Local model', none: 'No model' } as const;

export const McpAndAgentsHub: React.FC<McpAndAgentsHubProps> = ({
  mcpServers,
  externalMcpServers = [],
  multiAgentReport,
  onRefreshAgents,
}) => {
  const configuredExternal = externalMcpServers.filter((s) => s.status !== 'NOT_CONFIGURED');
  const suggestedExternal = externalMcpServers.filter((s) => s.status === 'NOT_CONFIGURED');
  const modelSteps = multiAgentReport?.steps.filter((st) => st.execution === 'LLM_AGENT').length ?? 0;
  const models = multiAgentReport?.activeLlms ?? [];
  const [selectedServerId, setSelectedServerId] = useState<string>(
    mcpServers[0]?.id || 'lex-statute-ingest-mcp'
  );
  const [invocationResult, setInvocationResult] = useState<McpToolInvocationResult | null>(
    null
  );
  const [isInvoking, setIsInvoking] = useState(false);

  const selectedServer =
    mcpServers.find((s) => s.id === selectedServerId) || mcpServers[0];

  const handleInvokeTool = async (
    serverId: string,
    toolName: string,
    sampleArgs: Record<string, unknown>
  ) => {
    setIsInvoking(true);
    try {
      const res = await fetch(`/api/mcp/${serverId}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, arguments: sampleArgs }),
      });
      if (res.ok) {
        const data = (await res.json()) as McpToolInvocationResult;
        setInvocationResult(data);
      }
    } finally {
      setIsInvoking(false);
    }
  };

  return (
    <div className="p-6 space-y-6 w-full">
      {/* Top Banner Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-[#0D131F] border border-indigo-500/40">
          <div className="text-[11px] font-mono uppercase text-indigo-300">
            MCP Servers
          </div>
          <div className="text-2xl font-bold text-white mt-1">
            {mcpServers.length} Built-in · {configuredExternal.length} External
          </div>
          <div className="text-xs text-slate-400 mt-1 font-mono">
            Transports: stdio · Streamable HTTP
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#0D131F] border border-emerald-500/40">
          <div className="text-[11px] font-mono uppercase text-emerald-300">
            Agent Pipeline
          </div>
          <div className="text-2xl font-bold text-white mt-1">
            {multiAgentReport ? `${multiAgentReport.steps.length} Steps` : 'Not run yet'}
          </div>
          <div className="text-xs text-slate-400 mt-1 font-mono">
            {modelSteps > 0 ? `${modelSteps} run a model; the rest call their tool directly` : 'No model: each step calls its MCP tool directly'}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#0D131F] border border-amber-500/40">
          <div className="text-[11px] font-mono uppercase text-amber-300">
            Models
          </div>
          <div className="text-2xl font-bold text-white mt-1">
            {models.length > 0 ? `${models.length} Configured` : 'None Configured'}
          </div>
          <div className="text-xs text-slate-400 mt-1 font-mono">
            {models.length > 0 ? models.map((m) => m.model).join(' · ') : 'Set LEXCOMPILER_LLM_MODEL (product guide, section 5.2)'}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#0D131F] border border-sky-500/40">
          <div className="text-[11px] font-mono uppercase text-sky-300">
            Pipeline Token Savings
          </div>
          <div className="text-2xl font-bold text-white mt-1">
            {multiAgentReport ? `${multiAgentReport.tokenSavingsPercent}% Reduced` : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1 font-mono">
            {multiAgentReport ? `${multiAgentReport.totalRawTokens} → ${multiAgentReport.totalOptimizedTokens} tokens` : 'Run the pipeline to measure'}
          </div>
        </div>
      </div>

      {/* SECTION 1: 6 Custom-Built MCP Servers + Live JSON-RPC 2.0 Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-100 flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              Built-in Model Context Protocol (MCP) Servers (Live JSON-RPC 2.0)
            </h2>
            <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
              <Radio className="w-3.5 h-3.5 animate-pulse" /> {mcpServers.reduce((n, s) => n + s.toolsCount, 0)} tools on {mcpServers.length} servers
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mcpServers.map((srv) => {
              const isSelected = srv.id === selectedServer?.id;
              const firstTool = srv.tools[0];
              return (
                <div
                  key={srv.id}
                  onClick={() => setSelectedServerId(srv.id)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-indigo-950/50 border-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.25)]'
                      : 'bg-[#0B101B] hover:bg-[#0F1625] border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedServerId(srv.id);
                      }}
                      className="text-xs font-mono font-bold text-indigo-300 truncate text-left cursor-pointer"
                    >
                      {srv.id}
                    </button>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {srv.toolsCount} tools · {srv.resourcesCount} res
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-slate-100 mb-1">{srv.name}</div>
                  <p className="text-[11px] text-slate-400 line-clamp-2 mb-2.5">
                    {srv.description}
                  </p>
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                    <div className="flex gap-1">
                      {srv.transports.map((tr) => (
                        <span
                          key={tr}
                          className="px-1.5 py-0.5 rounded text-[9.5px] font-mono bg-slate-800 text-slate-300"
                        >
                          {tr}
                        </span>
                      ))}
                    </div>
                    {firstTool && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedServerId(srv.id);
                          handleInvokeTool(srv.id, firstTool.name, firstTool.sampleArgs);
                        }}
                        aria-label={`Invoke ${firstTool.name} on ${srv.id}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10.5px] font-mono font-semibold bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer"
                      >
                        <Play className="w-3 h-3" aria-hidden="true" /> Invoke RPC
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* External MCP servers: only the ones that answer count as connected */}
          <div className="pt-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-2.5 flex items-center gap-2">
              <Network className="w-4 h-4 text-emerald-400" />
              External MCP Servers
            </h3>
            {configuredExternal.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                {configuredExternal.map((ext) => (
                  <div key={ext.id} className="p-2.5 rounded-lg bg-[#090D16] border border-slate-800/90 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono font-bold text-emerald-300 truncate">{ext.id}</span>
                      <span className="text-[9.5px] font-mono text-slate-400">
                        {ext.status} · {ext.liveTools?.length ?? 0} tools
                      </span>
                    </div>
                    <div className="text-[11px] font-medium text-slate-200">{ext.name}</div>
                    <p className="text-[10.5px] text-slate-400">{ext.error || ext.purpose}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">
                None connected. Add servers to <code>mcp-servers.json</code> (or the file named by{' '}
                <code>LEXCOMPILER_EXTERNAL_MCP_CONFIG</code>); they count once they answer <code>tools/list</code>.
                {suggestedExternal.length > 0 && ` Suggested: ${suggestedExternal.map((e) => e.id).join(', ')}.`}
              </p>
            )}
          </div>
        </div>

        {/* Live MCP JSON-RPC 2.0 Wire Inspector */}
        <div className="lg:col-span-5 flex flex-col rounded-xl bg-[#070A10] border border-slate-800 overflow-hidden">
          <div className="px-4 py-3 bg-[#0D131F] border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-mono font-bold text-slate-100">
                Live MCP JSON-RPC 2.0 Wire Inspector
              </span>
            </div>
            {selectedServer && (
              <span className="text-[10px] font-mono text-indigo-300">
                {selectedServer.endpointUrl}
              </span>
            )}
          </div>

          <div className="p-4 space-y-3 flex-1 overflow-y-auto">
            {selectedServer && (
              <div className="p-3 rounded-lg bg-[#0B101B] border border-slate-800 space-y-2">
                <div className="text-xs font-semibold text-slate-200">
                  Selected Server: {selectedServer.name}
                </div>
                <div className="text-[11px] font-mono text-slate-400">
                  Stdio CLI: <code className="text-amber-300">{selectedServer.stdioCommand}</code>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {selectedServer.tools.map((tool) => (
                    <button
                      key={tool.name}
                      type="button"
                      disabled={isInvoking}
                      onClick={() =>
                        handleInvokeTool(selectedServer.id, tool.name, tool.sampleArgs)
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-semibold bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer"
                    >
                      <Play className="w-3 h-3" aria-hidden="true" />
                      Call tools/call: {tool.name}()
                    </button>
                  ))}
                </div>
              </div>
            )}

            {invocationResult ? (
              <div className="space-y-3" role="status" aria-label="JSON-RPC response">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-emerald-400 font-semibold">
                    ✓ JSON-RPC 2.0 Response ({invocationResult.latencyMs} ms)
                  </span>
                  <span className="text-slate-400">{invocationResult.serverId}</span>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase text-slate-400 mb-1">
                    JSON-RPC 2.0 Request Payload:
                  </div>
                  <pre className="p-2.5 rounded bg-[#05070B] border border-slate-800 text-[11px] font-mono text-indigo-200 overflow-x-auto">
                    {JSON.stringify(invocationResult.jsonRpcRequest, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase text-slate-400 mb-1">
                    JSON-RPC 2.0 Response Payload:
                  </div>
                  <pre className="p-2.5 rounded bg-[#05070B] border border-slate-800 text-[11px] font-mono text-emerald-200 overflow-x-auto max-h-80">
                    {JSON.stringify(invocationResult.jsonRpcResponse, null, 2)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="p-6 text-center text-xs font-mono text-slate-400 border border-dashed border-slate-800 rounded-lg">
                Click "Invoke RPC" on any MCP server to execute a live JSON-RPC 2.0{' '}
                <code>tools/call</code> request and inspect the structured protocol response.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* SECTION 2: 6-Agent Neuro-Symbolic Execution Trace & Multi-LLM Router */}
      {multiAgentReport && (
        <div className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-100 flex items-center gap-2">
                <Bot className="w-4 h-4 text-emerald-400" />
                Agent Pipeline Trace
              </h2>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                {multiAgentReport.orchestrationPattern}
              </p>
            </div>
            <button
              type="button"
              onClick={onRefreshAgents}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-semibold bg-emerald-700 hover:bg-emerald-800 text-white cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5" aria-hidden="true" /> Run the Pipeline Again
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {multiAgentReport.steps.map((step) => (
              <article
                key={step.agentId}
                aria-label={`Step ${step.stepNumber}: ${step.agentName}`}
                className="p-3.5 rounded-xl bg-[#0B101B] border border-slate-800 flex flex-col justify-between space-y-2.5"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      Step {step.stepNumber} · {step.frameworkUsed}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                        step.runtime === 'local'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : step.runtime === 'cloud'
                            ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                            : 'bg-slate-700/40 text-slate-300 border border-slate-600/50'
                      }`}
                    >
                      {RUNTIME_LABEL[step.runtime] ?? step.runtime}
                    </span>
                  </div>
                  <div className="text-xs font-bold text-slate-100">{step.agentName}</div>
                  <div className="text-[11px] font-mono text-emerald-300">
                    Model: {step.llmModel}
                  </div>
                  <div className="text-[10.5px] font-mono text-indigo-300">
                    MCP Call: {step.mcpServerCalled} → {step.mcpToolCalled}()
                  </div>
                  {step.pythonAdapter && (
                    <div className="text-[10px] font-mono text-slate-400">Python adapter (separate): {step.pythonAdapter}</div>
                  )}
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    {step.reasoningSummary}
                  </p>
                </div>

                <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                  <pre className="p-2 rounded bg-[#06090F] text-[10px] font-mono text-slate-300 overflow-x-auto">
                    {step.structuredArtifactPreview}
                  </pre>
                  <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                    <span>
                      Tokens: <s>{step.inputTokensRaw}</s> →{' '}
                      <strong className="text-emerald-300">{step.inputTokensOptimized}</strong>
                    </span>
                    <span>Latency: {step.latencyMs} ms</span>
                  </div>
                </div>
              </article>
            ))}
          </div>

          {/* Models configured for the agents */}
          <div className="p-4 rounded-xl bg-[#0A0E17] border border-slate-800">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 mb-3 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-amber-400" />
              Configured Models
            </h3>
            {models.length === 0 ? (
              <p className="text-[11px] text-slate-400">
                No model is configured, so the steps above ran as direct tool calls. Set <code>LEXCOMPILER_LLM_MODEL</code> (or{' '}
                <code>LEXCOMPILER_AGENT_&lt;ID&gt;_MODEL</code>) to run them as tool-calling agents.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {models.map((m) => (
                  <div key={`${m.model}@${m.provider}`} className="p-3 rounded-lg bg-[#06090F] border border-slate-800/90 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold text-slate-100">{m.model}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9.5px] font-mono ${
                          m.isLocalRuntime
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                        }`}
                      >
                        {m.isLocalRuntime ? 'ON THIS MACHINE' : 'CLOUD'}
                      </span>
                    </div>
                    <div className="text-[10.5px] font-mono text-slate-400">
                      {m.provider} · {m.quantizationOrTier}
                    </div>
                    <p className="text-[11px] text-slate-300">{m.role}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 3: crew runs stored on this server (demo runs + imported Python crew runs) */}
      <LabCrewRuns />
    </div>
  );
};
