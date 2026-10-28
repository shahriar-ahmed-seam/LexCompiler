import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Code2,
  Cpu,
  Edit3,
  ExternalLink,
  FileText,
  Flame,
  Globe,
  Play,
  Radio,
  Scale,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type {
  ClauseVerificationProof,
  LegalClause,
  LiveRegulatoryFeedItem,
  RegulatoryMutationPreset,
} from '../../shared/types';

interface LegalCompilerPaneProps {
  clauses: LegalClause[];
  proofs: ClauseVerificationProof[];
  activeClauseId: string;
  mutationPresets: RegulatoryMutationPreset[];
  liveFeedItems: LiveRegulatoryFeedItem[];
  isCompiling: boolean;
  onSelectClause: (clauseId: string) => void;
  onCompileCustomProse: (clauseId: string, newProse: string) => void;
  onTriggerMutationPreset: (presetId: string) => void;
  onIngestLiveFeedItem: (item: LiveRegulatoryFeedItem) => void;
}

export const LegalCompilerPane: React.FC<LegalCompilerPaneProps> = ({
  clauses,
  proofs,
  activeClauseId,
  mutationPresets,
  liveFeedItems,
  isCompiling,
  onSelectClause,
  onCompileCustomProse,
  onTriggerMutationPreset,
  onIngestLiveFeedItem,
}) => {
  const activeClause = clauses.find((c) => c.id === activeClauseId) || clauses[0];
  const activeProof = proofs.find((p) => p.clauseId === activeClause?.id);

  const [draftProse, setDraftProse] = useState(activeClause?.rawLegalText || '');
  const [compilerTab, setCompilerTab] = useState<'DEONTIC' | 'SMT_Z3' | 'OPA_REGO' | 'AST_QUERY'>(
    'SMT_Z3'
  );
  const [showLiveFeed, setShowLiveFeed] = useState(false);

  useEffect(() => {
    if (activeClause) {
      setDraftProse(activeClause.rawLegalText);
    }
  }, [activeClause?.id, activeClause?.rawLegalText]);

  if (!activeClause) return null;

  const isDirty = draftProse.trim() !== activeClause.rawLegalText.trim();

  return (
    <div className="flex flex-col h-full bg-[#0A0E17] border-r border-slate-800/90">
      {/* Section Header: Statute & Contract Selector Tabs */}
      <div className="px-4 pt-3 pb-2 bg-[#0D131F] border-b border-slate-800/80">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Scale className="w-4 h-4 text-amber-400" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              1. Live Legal Statute & Deontic Compiler
            </h2>
          </div>

          <button
            type="button"
            onClick={() => setShowLiveFeed(!showLiveFeed)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono border transition-colors ${
              showLiveFeed
                ? 'bg-indigo-500/25 border-indigo-400 text-indigo-200'
                : 'bg-slate-800/80 hover:bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
            EUR-Lex / Federal Register Feed ({liveFeedItems.length})
          </button>
        </div>

        {/* Statute Tabs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {clauses.map((clause) => {
            const proof = proofs.find((p) => p.clauseId === clause.id);
            const isUnsat = proof?.status === 'UNSAT_VIOLATION';
            const isActive = clause.id === activeClause.id;

            return (
              <button
                key={clause.id}
                type="button"
                onClick={() => onSelectClause(clause.id)}
                className={`text-left p-2 rounded-md border transition-all ${
                  isActive
                    ? isUnsat
                      ? 'bg-rose-950/60 border-rose-400/80 text-slate-100 shadow-[0_0_12px_rgba(244,63,94,0.25)]'
                      : 'bg-emerald-950/50 border-emerald-400/80 text-slate-100'
                    : 'bg-[#090D15] hover:bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className="text-[10px] font-mono font-bold truncate text-slate-200">
                    {clause.citation.split('/')[0].trim()}
                  </span>
                  {isUnsat ? (
                    <span className="px-1 py-0.2 rounded text-[9px] font-mono font-bold bg-rose-500/25 text-rose-300 border border-rose-500/40">
                      UNSAT
                    </span>
                  ) : (
                    <span className="px-1 py-0.2 rounded text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      SAT
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-400 truncate">{clause.title}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Collapsible Live EUR-Lex / Federal Register Feed Drawer */}
      {showLiveFeed && (
        <div className="p-3 bg-indigo-950/30 border-b border-indigo-500/30 space-y-2 max-h-56 overflow-y-auto">
          <div className="flex items-center justify-between text-xs text-indigo-200 font-medium">
            <span className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-indigo-400" />
              Live Statutory Stream (EUR-Lex Official Journal & U.S. Federal Register API)
            </span>
            <button
              type="button"
              onClick={() => setShowLiveFeed(false)}
              className="text-[11px] font-mono text-slate-400 hover:text-slate-200"
            >
              Close ✕
            </button>
          </div>
          {liveFeedItems.map((item) => (
            <div
              key={item.id}
              className="p-2.5 rounded bg-[#0B0F19] border border-slate-800 flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {item.source} · {item.documentNumber}
                </span>
                <span className="text-[10px] font-mono text-slate-400">
                  {item.publicationDate}
                </span>
              </div>
              <div className="text-xs font-semibold text-slate-200">{item.title}</div>
              <p className="text-[11px] text-slate-400 line-clamp-2 font-legal">{item.excerpt}</p>
              <div className="flex items-center justify-between pt-1">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] font-mono text-indigo-400 hover:underline inline-flex items-center gap-1"
                >
                  Official Statute Source <ExternalLink className="w-2.5 h-2.5" />
                </a>
                <button
                  type="button"
                  onClick={() => {
                    onIngestLiveFeedItem(item);
                    setShowLiveFeed(false);
                  }}
                  className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-indigo-600 hover:bg-indigo-500 text-white"
                >
                  Ingest & Compile Statute →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Active Legal Document Editor & Live Mutation Trigger */}
      <div className="p-4 border-b border-slate-800/80 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                {activeClause.citation}
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                {activeClause.deontic.modality} · {activeClause.deontic.deonticOperatorSymbol}
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                {activeClause.version}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-slate-100 mt-1">{activeClause.title}</h3>
          </div>
        </div>

        {/* Live Editable Legal Prose Box */}
        <div className="relative">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400 mb-1.5">
            <span className="inline-flex items-center gap-1">
              <Edit3 className="w-3 h-3 text-amber-400" />
              Editable Statutory / Contractual Prose (Supports English &amp; বাংলা):
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const banglaClause =
                    'ধারা ৪.২ (বাংলাদেশ ব্যাংক আইসিটি নিরাপত্তা নীতিমালা ও সাইবার নিরাপত্তা আইন / Bangladesh Bank ICT Guideline §4.2): গ্রাহকের সকল ব্যক্তিগত ও আর্থিক তথ্য (PII/PHI) অবশ্যই টেন্যান্ট-আইসোলেটেড KMS কী (tenant-isolated keys) দ্বারা এনক্রিপ্টেড থাকতে হবে এবং ৪৮ ঘণ্টা (48 hours)-এর মধ্যে ডাটাবেস ও ক্যাশ থেকে সম্পূর্ণরূপে মুছে ফেলতে হবে।';
                  setDraftProse(banglaClause);
                  onCompileCustomProse(activeClause.id, banglaClause);
                }}
                className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 cursor-pointer transition-colors"
                title="Compile Bangladesh Bank ICT Guideline in Bangla (৪৮ ঘণ্টা / 48h + Tenant KMS)"
              >
                বাংলা (BD Bank ICT §4.2 · ৪৮ ঘণ্টা)
              </button>
              {isDirty && (
                <span className="text-amber-300 font-semibold animate-pulse">
                  ● Uncompiled Edit
                </span>
              )}
            </div>
          </div>
          <textarea
            value={draftProse}
            onChange={(e) => setDraftProse(e.target.value)}
            rows={4}
            aria-label="Editable Statutory or Contractual Prose"
            className="w-full rounded-lg bg-[#070A10] border border-slate-700/90 focus:border-amber-400/90 focus:outline-none p-3 text-[13.5px] leading-relaxed text-slate-100 font-legal resize-y shadow-inner"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
            {/* Extracted Deontic Parameter Badges */}
            <div className="flex flex-wrap items-center gap-1.5">
              {activeClause.deontic.extractedParameters.maxRetentionHours !== undefined && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-200 border border-indigo-500/30">
                  max_ttl: {activeClause.deontic.extractedParameters.maxRetentionHours}h (
                  {activeClause.deontic.extractedParameters.maxRetentionDays}d)
                </span>
              )}
              {activeClause.deontic.extractedParameters.requiresTenantIsolatedKeys !==
                undefined && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-200 border border-amber-500/30">
                  tenant_isolated_kms:{' '}
                  {String(activeClause.deontic.extractedParameters.requiresTenantIsolatedKeys)}
                </span>
              )}
              {activeClause.deontic.extractedParameters.minAiConfidenceThreshold !==
                undefined && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-200 border border-indigo-500/30">
                  min_ai_confidence:{' '}
                  {Math.round(
                    activeClause.deontic.extractedParameters.minAiConfidenceThreshold * 100
                  )}
                  %
                </span>
              )}
              {activeClause.deontic.extractedParameters.allowedDataRegions && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-200 border border-indigo-500/30">
                  regions: {activeClause.deontic.extractedParameters.allowedDataRegions.join(', ')}
                </span>
              )}
            </div>

            <button
              type="button"
              disabled={isCompiling}
              onClick={() => onCompileCustomProse(activeClause.id, draftProse)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition-all cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {isCompiling ? 'Compiling to Z3...' : 'Compile Prose → Z3 & AST'}
            </button>
          </div>
        </div>

        {/* Quick Regulatory Mutation Scenarios Strip */}
        <div className="pt-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-rose-400" />
            Instant Regulatory Amendment Scenarios (Live Shockwave Triggers):
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {mutationPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onTriggerMutationPreset(preset.id)}
                className="text-left p-2 rounded border border-slate-800 hover:border-amber-400/60 bg-[#0D131F]/90 hover:bg-slate-900/90 transition-all group cursor-pointer"
              >
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className="text-[10px] font-mono font-bold text-amber-300 group-hover:text-amber-200 truncate">
                    {preset.badge}
                  </span>
                  <span className="text-[9px] font-mono text-slate-400">
                    {preset.blastRadiusNodeIds.length} nodes
                  </span>
                </div>
                <div className="text-[11px] font-medium text-slate-200 line-clamp-1">
                  {preset.name}
                </div>
                <div className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                  {preset.parameterDiffSummary}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Half of Left Pane: Compiled Neuro-Symbolic Formal Logic & Z3 SMT-LIB2 Inspector */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Compiler Sub-Tabs */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#0D131F] border-b border-slate-800/80">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCompilerTab('SMT_Z3')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                compilerTab === 'SMT_Z3'
                  ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Z3 SMT-LIB2 + Unsat Core
            </button>
            <button
              type="button"
              onClick={() => setCompilerTab('DEONTIC')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                compilerTab === 'DEONTIC'
                  ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Deontic Logic IR
            </button>
            <button
              type="button"
              onClick={() => setCompilerTab('OPA_REGO')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                compilerTab === 'OPA_REGO'
                  ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              OPA Rego Policy
            </button>
            <button
              type="button"
              onClick={() => setCompilerTab('AST_QUERY')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                compilerTab === 'AST_QUERY'
                  ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tree-sitter AST Query
            </button>
          </div>

          {activeProof && (
            <span className="text-[10px] font-mono text-slate-400">
              Z3 Time: <strong className="text-slate-200">{activeProof.z3SolveTimeMs} ms</strong>
            </span>
          )}
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {compilerTab === 'SMT_Z3' && activeProof && (
            <>
              {/* UNSAT Core Banner */}
              {activeProof.status === 'UNSAT_VIOLATION' ? (
                <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/40 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-rose-300 flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4 text-rose-400" />
                      Z3 UNSAT CORE EXTRACTED (MATHEMATICAL CONTRADICTION)
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-200">
                      check-sat → unsat
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {activeProof.unsatCoreAssertions.map((core) => (
                      <span
                        key={core}
                        className="px-2 py-0.5 rounded text-[11px] font-mono bg-rose-500/20 text-rose-200 border border-rose-500/40"
                      >
                        ! {core}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-emerald-950/35 border border-emerald-500/40 flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    Z3 FORMAL PROOF SATISFIED (Q.E.D. — ZERO CONTRADICTIONS)
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">
                    check-sat → sat
                  </span>
                </div>
              )}

              {/* SMT-LIB2 Code Block */}
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1">
                  Executed SMT-LIB2 Formal Specification (Statute Axioms ∧ Extracted AST Facts):
                </div>
                <pre className="p-3 rounded-lg bg-[#06090F] border border-slate-800 text-[11.5px] font-mono text-indigo-200 overflow-x-auto leading-relaxed">
                  {activeProof.smtLib2Executed}
                </pre>
              </div>
            </>
          )}

          {compilerTab === 'DEONTIC' && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-[#070A10] border border-slate-800 space-y-2">
                <div className="text-[10px] font-mono uppercase text-amber-400">
                  Modal Deontic Formula
                </div>
                <div className="text-xs font-mono text-slate-100 bg-slate-900/90 p-2.5 rounded border border-slate-800">
                  {activeClause.compiled.deonticFormula}
                </div>
                <div className="text-[10px] font-mono uppercase text-indigo-400 pt-1">
                  First-Order Predicate Logic
                </div>
                <div className="text-xs font-mono text-slate-200 bg-slate-900/90 p-2.5 rounded border border-slate-800">
                  {activeClause.compiled.firstOrderLogic}
                </div>
              </div>

              {activeProof && (
                <div className="p-3 rounded-lg bg-[#070A10] border border-slate-800 space-y-2">
                  <div className="text-[10px] font-mono uppercase text-slate-400">
                    Step-by-Step Neuro-Symbolic Deduction Trace
                  </div>
                  {activeProof.formalProofSteps.map((step) => (
                    <div
                      key={step.stepNumber}
                      className="p-2 rounded bg-slate-900/70 border border-slate-800/80 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between font-mono text-[11px] text-indigo-300">
                        <span>
                          Step {step.stepNumber}: {step.ruleName}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-slate-100 bg-[#05070B] p-1.5 rounded">
                        {step.formula}
                      </div>
                      <div className="text-[11px] text-slate-400">{step.justification}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {compilerTab === 'OPA_REGO' && activeProof && (
            <div className="space-y-3">
              {activeProof.opaRegoTriggeredDenials.length > 0 && (
                <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/40 space-y-1">
                  <div className="text-xs font-mono font-bold text-rose-300">
                    Triggered OPA Rego Deny Rules ({activeProof.opaRegoTriggeredDenials.length}):
                  </div>
                  {activeProof.opaRegoTriggeredDenials.map((msg, i) => (
                    <div key={i} className="text-[11px] font-mono text-rose-200">
                      • {msg}
                    </div>
                  ))}
                </div>
              )}
              <pre className="p-3 rounded-lg bg-[#06090F] border border-slate-800 text-[11.5px] font-mono text-emerald-200 overflow-x-auto leading-relaxed">
                {activeClause.compiled.opaRegoRule}
              </pre>
            </div>
          )}

          {compilerTab === 'AST_QUERY' && (
            <div className="space-y-2">
              <div className="text-[11px] text-slate-400">
                Polyglot Tree-sitter / Compiler AST S-Expression Query matching SQL DDL, Python 3
                AST, and TypeScript AST nodes:
              </div>
              <pre className="p-3 rounded-lg bg-[#06090F] border border-slate-800 text-[11.5px] font-mono text-amber-200 overflow-x-auto leading-relaxed">
                {activeClause.compiled.astPatternQuery}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
