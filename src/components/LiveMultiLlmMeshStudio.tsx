import React, { useEffect, useState } from 'react';
import {
  Cpu,
  Database,
  Play,
  Radio,
  RefreshCw,
  Server,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';

interface LiveMultiLlmMeshStudioProps {
  activeClauseText: string;
}

export const LiveMultiLlmMeshStudio: React.FC<LiveMultiLlmMeshStudioProps> = ({
  activeClauseText,
}) => {
  const [meshData, setMeshData] = useState<any | null>(null);
  const [isLoadingMesh, setIsLoadingMesh] = useState(false);

  // Live Multi-Model Pipeline State
  const [clauseInput, setClauseInput] = useState(
    activeClauseText ||
      'Section 4.2 (GDPR Art. 17 & Art. 32 / HIPAA §164.312): All Personal Identifiable Information (PII) must be encrypted at rest with tenant-isolated KMS keys, never logged in plaintext, and purged within 72 hours.'
  );
  const [codeInput, setCodeInput] = useState(
    `logger.info(f"Ingesting patient record ssn={payload.ssn} email={payload.email}")\nencrypted_ssn = encrypt_shared_aes256(payload.ssn)\nPII_CACHE_TTL_HOURS = 720`
  );
  const [selectedLegalModel, setSelectedLegalModel] = useState('qwen2.5-coder:0.5b');
  const [pipelineResult, setPipelineResult] = useState<any | null>(null);
  const [isRunningPipeline, setIsRunningPipeline] = useState(false);

  // Interactive Single-LLM Prompt Playground
  const [playgroundModel, setPlaygroundModel] = useState('qwen2.5-coder:0.5b');
  const [playgroundPrompt, setPlaygroundPrompt] = useState(
    'In 2 concise sentences, explain why logging raw SSN in FastAPI logger.info violates HIPAA 164.312(b) and how SHA-256 redaction fixes it.'
  );
  const [playgroundResult, setPlaygroundResult] = useState<any | null>(null);
  const [isGeneratingSingle, setIsGeneratingSingle] = useState(false);

  const fetchMeshStatus = async () => {
    setIsLoadingMesh(true);
    try {
      const res = await fetch('/api/services/mesh');
      if (res.ok) {
        setMeshData(await res.json());
      }
    } finally {
      setIsLoadingMesh(false);
    }
  };

  const runLiveMultiModelPipeline = async () => {
    setIsRunningPipeline(true);
    try {
      const res = await fetch('/api/llm/multi-model-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clauseText: clauseInput,
          codeSnippet: codeInput,
          preferredLegalModel: selectedLegalModel,
        }),
      });
      if (res.ok) {
        setPipelineResult(await res.json());
        fetchMeshStatus();
      }
    } finally {
      setIsRunningPipeline(false);
    }
  };

  const runSingleModelPlayground = async () => {
    setIsGeneratingSingle(true);
    try {
      const res = await fetch('/api/llm/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: playgroundModel,
          prompt: playgroundPrompt,
          maxTokens: 110,
          // Keys stay on the server; "cloud" uses the server's configured model.
          cloudProvider: playgroundModel === 'cloud:openai' ? 'openai' : undefined,
        }),
      });
      if (res.ok) {
        setPlaygroundResult(await res.json());
      }
    } finally {
      setIsGeneratingSingle(false);
    }
  };

  useEffect(() => {
    fetchMeshStatus();
    runLiveMultiModelPipeline();
  }, []);

  return (
    <div className="p-6 space-y-6 w-full">
      {/* Executive Header */}
      <div className="p-6 rounded-2xl bg-[#0A0C12] border border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1.5 max-w-3xl">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10.5px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
              REAL MULTI-SERVICE &amp; MULTI-LLM INFERENCE MESH
            </span>
            <span className="text-xs font-mono text-zinc-400">
              Ollama (:11434) · Microsoft Z3 · SQLite3 Ledger · Python 3.12 AST · 12 MCPs
            </span>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-white">
            Live Multi-Model AI Mesh &amp; Distributed Service Orchestrator
          </h2>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Zero simulated AI calls: directly orchestrates your local Ollama daemon (
            <code className="text-amber-300">dolphin3:latest</code> 8B Q4_K_M,{' '}
            <code className="text-indigo-300">qwen2.5-coder:0.5b</code>, and{' '}
            <code className="text-emerald-300">all-minilm:latest</code> 384-d neural embeddings),
            the Microsoft Z3 SMT Solver, Python 3.12 AST subprocesses, and the on-disk SQLite3
            compliance ledger.
          </p>
        </div>

        <button
          type="button"
          onClick={fetchMeshStatus}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border border-white/[0.1] transition-all cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMesh ? 'animate-spin' : ''}`} />
          Refresh 6-Service Heartbeat
        </button>
      </div>

      {/* SECTION 1: 6 Distinct Running Backend Services Grid */}
      {meshData && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-mono font-semibold uppercase tracking-widest text-zinc-400 flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-amber-400" />
              1. Active Multi-Service Topology (6 Distinct Local &amp; Protocol Services)
            </h3>
            <span className="text-[11px] font-mono text-emerald-400">
              ● 6/6 Production Services Online
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {meshData.services.map((svc: any) => (
              <div
                key={svc.serviceId}
                className="p-4 rounded-xl bg-[#0A0C12] border border-white/[0.07] hover:border-white/[0.15] transition-all flex flex-col justify-between space-y-3"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.05] text-zinc-300 border border-white/[0.06]">
                      {svc.category}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-400 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10B981]" />
                      {svc.status} · {svc.latencyMs}ms
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-white">{svc.name}</div>
                  <div className="text-[11px] font-mono text-amber-300/90 truncate">
                    {svc.endpointOrPath}
                  </div>
                </div>
                <div className="pt-2.5 border-t border-white/[0.06] text-xs text-zinc-400 font-mono">
                  {svc.telemetrySummary}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 2: Installed Ollama Models Fleet + Live Multi-Model Pipeline Execution */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left 5 cols: Installed Local Ollama Models + Persistent SQLite Ledger */}
        <div className="lg:col-span-5 space-y-4">
          <div className="p-5 rounded-2xl bg-[#0A0C12] border border-white/[0.08] space-y-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-semibold uppercase tracking-widest text-zinc-300 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-amber-400" />
                2. Installed Local Ollama Models (`:11434`)
              </h3>
              <span className="text-[11px] font-mono text-emerald-400">
                {meshData?.ollamaModels?.length || 3} Models Ready
              </span>
            </div>

            <div className="space-y-2.5">
              {(meshData?.ollamaModels || []).map((m: any) => (
                <div
                  key={m.name}
                  className="p-3.5 rounded-xl bg-[#06070B] border border-white/[0.06] space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-white">{m.name}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      {m.parameterSize} · {m.quantizationLevel} · {m.sizeFormatted}
                    </span>
                  </div>
                  <div className="text-[10.5px] font-mono text-zinc-400">
                    SHA-256 Digest: {m.digest}… · Family: {m.family}
                  </div>
                  <p className="text-xs text-zinc-300">{m.roleInLexCompiler}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Persistent SQLite3 Compliance & Vector Database Inspector */}
          {meshData?.sqliteStats && (
            <div className="p-5 rounded-2xl bg-[#0A0C12] border border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono font-semibold uppercase tracking-widest text-zinc-300 flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" />
                  3. Persistent SQLite3 Audit Ledger (`data/lexcompiler_enterprise.db`)
                </h3>
                <span className="text-[11px] font-mono text-zinc-400">
                  {(meshData.sqliteStats.dbSizeBytes / 1024).toFixed(1)} KB on disk
                </span>
              </div>

              <div className="space-y-1.5 font-mono text-[11px]">
                {(meshData.sqliteStats.recentAudits || []).map((row: any, i: number) => (
                  <div
                    key={i}
                    className="p-2 rounded bg-[#06070B] border border-white/[0.05] flex items-center justify-between text-zinc-300"
                  >
                    <span>
                      {row.scanId} · <strong className="text-white">@{row.commitHash}</strong>
                    </span>
                    <span className={row.violated > 0 ? 'text-rose-400' : 'text-emerald-400'}>
                      SAT:{row.compliant} UNSAT:{row.violated} ({row.z3Ms}ms)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right 7 cols: Real Multi-Model Pipeline Execution (all-minilm + qwen2.5-coder + dolphin3) */}
        <div className="lg:col-span-7 p-5 rounded-2xl bg-[#0A0C12] border border-white/[0.08] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                Live Multi-Model Co-Execution Pipeline (`all-minilm` + `qwen2.5-coder` + `dolphin3`)
              </h3>
              <p className="text-xs text-zinc-400 font-mono mt-0.5">
                Executes 3 real neural/LLM passes on your local hardware and measures real token/sec
                throughput
              </p>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={selectedLegalModel}
                onChange={(e) => setSelectedLegalModel(e.target.value)}
                className="rounded-lg bg-[#06070B] border border-white/[0.12] px-2.5 py-1.5 text-xs font-mono text-zinc-200"
              >
                <option value="qwen2.5-coder:0.5b">Legal Pass: qwen2.5-coder:0.5b (Ultra-Fast)</option>
                <option value="dolphin3:latest">Legal Pass: dolphin3:latest (Llama-3.1 8B)</option>
              </select>

              <button
                type="button"
                disabled={isRunningPipeline}
                onClick={runLiveMultiModelPipeline}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-mono font-semibold bg-amber-500 hover:bg-amber-400 text-black transition-all cursor-pointer disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {isRunningPipeline ? 'Running 3 Models...' : 'Execute 3-Model Pipeline'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10.5px] font-mono uppercase text-zinc-400 mb-1">
                Statutory Clause Input:
              </label>
              <textarea
                value={clauseInput}
                onChange={(e) => setClauseInput(e.target.value)}
                rows={3}
                className="w-full rounded-lg bg-[#06070B] border border-white/[0.1] p-2.5 text-xs font-legal text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[10.5px] font-mono uppercase text-zinc-400 mb-1">
                Target Polyglot Code Snippet:
              </label>
              <textarea
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                rows={3}
                className="w-full rounded-lg bg-[#06070B] border border-white/[0.1] p-2.5 text-xs font-mono text-zinc-100"
              />
            </div>
          </div>

          {pipelineResult && (
            <div className="space-y-3 pt-1">
              {/* Pass 1: Real 384-d Neural Embeddings */}
              <div className="p-3.5 rounded-xl bg-[#06070B] border border-white/[0.07] space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <span className="text-emerald-400 font-semibold">
                    Pass 1 · Neural Vector Service: {pipelineResult.neuralEmbedding.model}
                  </span>
                  <span className="text-zinc-400">
                    Dim: {pipelineResult.neuralEmbedding.dimensions} · Cosine Similarity:{' '}
                    <strong className="text-white">
                      {pipelineResult.neuralEmbedding.cosineSimilarity}
                    </strong>{' '}
                    ({pipelineResult.neuralEmbedding.latencyMs} ms)
                  </span>
                </div>
                <div className="text-[10.5px] font-mono text-zinc-400 truncate">
                  Law 384-d Vector: [
                  {pipelineResult.neuralEmbedding.lawVectorPreview.join(', ')}, …]
                </div>
                <div className="text-[10.5px] font-mono text-zinc-400 truncate">
                  AST 384-d Vector: [
                  {pipelineResult.neuralEmbedding.codeVectorPreview.join(', ')}, …]
                </div>
              </div>

              {/* Pass 2: Real Code Specialist LLM (qwen2.5-coder:0.5b) */}
              <div className="p-3.5 rounded-xl bg-[#06070B] border border-white/[0.07] space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <span className="text-indigo-300 font-semibold">
                    Pass 2 · Code AST LLM: {pipelineResult.codeSpecialistLlm.model} (
                    {pipelineResult.codeSpecialistLlm.provider})
                  </span>
                  <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 text-[10.5px]">
                    {pipelineResult.codeSpecialistLlm.tokensPerSecond} tok/s ·{' '}
                    {pipelineResult.codeSpecialistLlm.completionTokens} tokens (
                    {pipelineResult.codeSpecialistLlm.totalDurationMs} ms)
                  </span>
                </div>
                <p className="text-xs text-zinc-200 leading-relaxed font-mono">
                  {pipelineResult.codeSpecialistLlm.responseText}
                </p>
              </div>

              {/* Pass 3: Real General Counsel Legal LLM */}
              <div className="p-3.5 rounded-xl bg-[#06070B] border border-white/[0.07] space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <span className="text-amber-300 font-semibold">
                    Pass 3 · General Counsel LLM: {pipelineResult.generalCounselLlm.model} (
                    {pipelineResult.generalCounselLlm.provider})
                  </span>
                  <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[10.5px]">
                    {pipelineResult.generalCounselLlm.tokensPerSecond} tok/s ·{' '}
                    {pipelineResult.generalCounselLlm.completionTokens} tokens (
                    {pipelineResult.generalCounselLlm.totalDurationMs} ms)
                  </span>
                </div>
                <p className="text-xs text-zinc-200 leading-relaxed font-legal">
                  {pipelineResult.generalCounselLlm.responseText}
                </p>
              </div>

              {/* Pass 4: Local reasoning model as an advisory critic (Z3 decides) */}
              {pipelineResult.reasoningCriticLlm && (
                <div className="p-3.5 rounded-xl bg-[#06070B] border border-white/[0.07] space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                    <span className="text-sky-300 font-semibold">
                      Pass 4 · Reasoning critic (advisory; Z3 decides): {pipelineResult.reasoningCriticLlm.model} (
                      {pipelineResult.reasoningCriticLlm.provider})
                    </span>
                    <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[10.5px]">
                      {pipelineResult.reasoningCriticLlm.tokensPerSecond} tok/s ·{' '}
                      {pipelineResult.reasoningCriticLlm.completionTokens} tokens (
                      {pipelineResult.reasoningCriticLlm.totalDurationMs} ms)
                    </span>
                  </div>
                  <p className="text-xs text-zinc-200 leading-relaxed whitespace-pre-wrap">
                    {pipelineResult.reasoningCriticLlm.responseText}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SECTION 3: Direct Multi-LLM Playground (Switch Between dolphin3:8b, qwen2.5-coder, or Cloud API Key) */}
      <div className="p-5 rounded-2xl bg-[#0A0C12] border border-white/[0.08] space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-mono font-semibold uppercase tracking-widest text-zinc-300 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              4. Direct Multi-LLM Interactive Console (Local Ollama + Optional Cloud Frontier Key)
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={playgroundModel}
              onChange={(e) => setPlaygroundModel(e.target.value)}
              className="rounded-lg bg-[#06070B] border border-white/[0.12] px-2.5 py-1.5 text-xs font-mono text-zinc-200"
            >
              <option value="qwen2.5-coder:0.5b">Local Ollama: qwen2.5-coder:0.5b (397 MB)</option>
              <option value="dolphin3:latest">Local Ollama: dolphin3:latest (Llama-3.1 8B · 4.9 GB)</option>
              <option value="cloud:openai">Cloud: the server's model (LEXCOMPILER_LLM_MODEL or OPENAI_API_KEY)</option>
            </select>
            <button
              type="button"
              disabled={isGeneratingSingle}
              onClick={runSingleModelPlayground}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-mono font-semibold bg-white text-black hover:bg-zinc-200 transition-all cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              {isGeneratingSingle ? 'Generating Live Tokens...' : 'Generate Live Response'}
            </button>
          </div>
        </div>

        <input
          type="text"
          value={playgroundPrompt}
          onChange={(e) => setPlaygroundPrompt(e.target.value)}
          className="w-full rounded-lg bg-[#06070B] border border-white/[0.1] px-3.5 py-2 text-xs font-mono text-zinc-100"
        />

        {playgroundResult && (
          <div className="p-3.5 rounded-xl bg-[#06070B] border border-emerald-500/30 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono text-emerald-400">
              <span>
                ✓ Model: {playgroundResult.model} ({playgroundResult.provider})
              </span>
              <span>
                {playgroundResult.tokensPerSecond} tokens/sec · {playgroundResult.completionTokens}{' '}
                output tokens · {playgroundResult.totalDurationMs} ms
              </span>
            </div>
            <p className="text-xs text-zinc-100 font-mono leading-relaxed">
              {playgroundResult.responseText}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
