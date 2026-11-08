import { useEffect, useState } from 'react';
import { History } from 'lucide-react';

/**
 * Crew runs stored on this server (agent_crew_runs, workspace IS NULL): demo runs started from
 * /api/agents/crew/runs and runs the Python crew (python -m lexcompiler_agents crew) reported.
 * Read-only — the workspace Checks page shows runs against a workspace's own repositories.
 */

interface CrewStep {
  stepNumber: number;
  agentName: string;
  pythonAdapter: string;
  summary: string;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  error?: string;
}
type Gate = 'NOTHING_TO_FIX' | 'PATCH_VERIFIED' | 'PATCH_BLOCKED' | 'INCOMPLETE';
interface CrewRunSummary {
  id: string;
  source: 'server' | 'python';
  startedAt: string;
  status: 'COMPLETED' | 'FAILED';
  gate: Gate;
  useModels: boolean;
  totalTokens: number;
  latencyMs: number;
  triggeredBy: string | null;
  target?: { repoFullName: string; commitSha: string };
  stepStatuses: string[];
}
interface CrewRun extends CrewRunSummary {
  steps: CrewStep[];
}

const GATE: Record<Gate, { text: string; className: string }> = {
  NOTHING_TO_FIX: { text: 'Nothing to fix', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  PATCH_VERIFIED: { text: 'Patch proven by Z3', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  PATCH_BLOCKED: { text: 'Patch not proven', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  INCOMPLETE: { text: 'A step failed', className: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
const commit = (sha?: string) => (!sha ? '' : sha === 'working-tree' ? 'working tree' : sha.slice(0, 7));

function RunSteps({ run }: { run: CrewRun }) {
  return (
    <ol className="space-y-1 pt-2">
      {run.steps.map((s) => (
        <li
          key={s.stepNumber}
          aria-label={`Step ${s.stepNumber}: ${s.agentName}`}
          className={`text-[11px] font-mono ${s.status === 'SKIPPED' ? 'text-slate-400' : s.status === 'FAILED' ? 'text-rose-300' : 'text-slate-300'}`}
        >
          <span className="font-semibold text-slate-100">
            {s.stepNumber}. {s.agentName}
          </span>{' '}
          <span className="text-slate-400">({s.pythonAdapter})</span>: {s.summary}
          {s.error && <span> {s.error}</span>}
        </li>
      ))}
    </ol>
  );
}

export function LabCrewRuns() {
  const [runs, setRuns] = useState<CrewRunSummary[] | null>(null);
  const [open, setOpen] = useState<Record<string, CrewRun>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/agents/crew/runs')
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setRuns(((await res.json()) as { runs: CrewRunSummary[] }).runs);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const toggle = async (id: string) => {
    if (open[id]) return setOpen(({ [id]: _closed, ...rest }) => rest);
    try {
      const res = await fetch(`/api/agents/crew/runs/${id}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const run = (await res.json()) as CrewRun;
      setOpen((o) => ({ ...o, [id]: run }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section aria-labelledby="lab-crew-runs-heading" className="space-y-3 pt-2">
      <div className="flex items-center justify-between">
        <h2 id="lab-crew-runs-heading" className="text-sm font-bold uppercase tracking-wider text-slate-100 flex items-center gap-2">
          <History className="w-4 h-4 text-sky-400" />
          Stored Crew Runs
        </h2>
        {runs && (
          <span className="text-xs font-mono text-slate-400">
            {runs.length} run{runs.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400">
        Every chained six-agent run this server stored — started here, or reported by the Python crew. Each step is what the
        agent's tool returned, and a patch only reaches the gate when Z3 proves it.
      </p>
      {error && (
        <p role="alert" className="rounded-lg px-3 py-2 text-xs font-mono bg-rose-950/60 border border-rose-500/40 text-rose-200">
          {error}
        </p>
      )}
      {runs && runs.length === 0 && (
        <p className="text-xs text-slate-400 border border-dashed border-slate-800 rounded-lg p-4">
          No stored runs yet. Run the pipeline above, or import one with the Python crew.
        </p>
      )}
      <ul className="space-y-2">
        {(runs ?? []).map((run) => {
          const label = `${run.target?.repoFullName ?? 'Demo clauses'}${run.target ? ` at ${commit(run.target.commitSha)}` : ''}`;
          return (
            <li key={run.id} aria-label={`Crew run on ${label}`} className="rounded-xl bg-[#0B101B] border border-slate-800 p-3 space-y-1">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-semibold text-slate-100">{label}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${GATE[run.gate].className}`}>{GATE[run.gate].text}</span>
                <span className="px-1.5 py-0.5 rounded text-[9.5px] font-mono bg-slate-800 text-slate-300">{run.source === 'python' ? 'Python crew' : 'This server'}</span>
                <span className="text-[10.5px] font-mono text-slate-400">
                  {when(run.startedAt)} · {(run.latencyMs / 1000).toFixed(1)} s · {run.totalTokens} tokens{run.useModels ? ' · models' : ''}
                  {run.triggeredBy ? ` · by ${run.triggeredBy}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => void toggle(run.id)}
                  aria-expanded={Boolean(open[run.id])}
                  className="text-[11px] font-mono text-sky-300 underline cursor-pointer"
                >
                  {open[run.id] ? `Hide the steps of the run on ${label}` : `Show the steps of the run on ${label}`}
                </button>
              </p>
              {open[run.id] && <RunSteps run={open[run.id]} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
