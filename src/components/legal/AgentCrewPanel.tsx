import { useCallback, useEffect, useState } from 'react';

/**
 * The agent crew on the workspace's repositories (AGENTS.md §2, guide 5.7): six agents in a
 * chain, from the regulation feed to a patch Z3 proves. Each step shows what the agent found
 * and what it passed on. No model runs from here, so a run costs nothing.
 */

interface Repo {
  id: string;
  fullName: string;
  source?: 'github' | 'local';
}
interface CrewStep {
  stepNumber: number;
  agentName: string;
  pythonAdapter: string;
  summary: string;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  error?: string;
  handoff: Record<string, unknown>;
}
type Gate = 'NOTHING_TO_FIX' | 'PATCH_VERIFIED' | 'PATCH_BLOCKED' | 'INCOMPLETE';
interface CrewRunSummary {
  id: string;
  startedAt: string;
  gate: Gate;
  status: 'COMPLETED' | 'FAILED';
  latencyMs: number;
  target?: { repoFullName: string; commitSha: string };
}
interface CrewRun extends CrewRunSummary {
  steps: CrewStep[];
}

const GATE: Record<Gate, { text: string; className: string }> = {
  NOTHING_TO_FIX: { text: 'Nothing to fix', className: 'bg-emerald-950 text-emerald-200' },
  PATCH_VERIFIED: { text: 'Patch proven by Z3', className: 'bg-emerald-950 text-emerald-200' },
  PATCH_BLOCKED: { text: 'Patch not proven', className: 'bg-amber-950 text-amber-200' },
  INCOMPLETE: { text: 'A step failed', className: 'bg-rose-950 text-rose-200' },
};

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && typeof json.error === 'string' && json.error) || `${res.status} ${res.statusText}`);
  return json as T;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
const commit = (sha?: string) => (!sha ? '' : sha === 'working-tree' ? 'working tree' : sha.slice(0, 7));

function RunDetails({ run }: { run: CrewRun }) {
  const pr = run.steps[5]?.handoff.pullRequest as { prNumber: number; url: string; created: boolean } | undefined;
  const prError = run.steps[5]?.handoff.pullRequestError as string | undefined;
  const modelFixes = (run.steps[5]?.handoff.modelFixes as Array<{ ruleKey: string; path: string; startLine: number; endLine: number; body: string }> | undefined) ?? [];
  return (
    <div className="space-y-1">
      <ol className="space-y-1 text-xs">
        {run.steps.map((s) => (
          <li key={s.stepNumber} aria-label={`Step ${s.stepNumber}: ${s.agentName}`} className={s.status === 'SKIPPED' ? 'text-zinc-400' : s.status === 'FAILED' ? 'text-rose-300' : 'text-zinc-300'}>
            <span className="font-semibold">
              {s.stepNumber}. {s.agentName}
            </span>{' '}
            <span className="text-zinc-400">({s.pythonAdapter})</span>: {s.summary}
            {s.error && <span> {s.error}</span>}
          </li>
        ))}
      </ol>
      {pr && (
        <p className="text-xs text-emerald-200">
          {pr.created ? 'Opened' : 'Already open for this commit:'}{' '}
          <a className="underline" href={pr.url} target="_blank" rel="noreferrer">
            pull request #{pr.prNumber}
          </a>
        </p>
      )}
      {prError && <p className="text-xs text-amber-200">No pull request: {prError}</p>}
      {modelFixes.length > 0 && (
        <div aria-label="Fix agent suggestions" role="region" className="space-y-1">
          <p className="text-xs text-zinc-300">Fix agent: model-written fixes that parse and that Z3 confirms. Review them; nothing was committed.</p>
          {modelFixes.map((f) => (
            <details key={`${f.path}:${f.startLine}`} className="text-xs">
              <summary className="cursor-pointer text-sky-300">
                {f.ruleKey} at {f.path}:{f.startLine}
                {f.endLine > f.startLine ? `–${f.endLine}` : ''}
              </summary>
              <pre className="whitespace-pre-wrap font-mono text-zinc-300 bg-[#0B101B] rounded p-2">{f.body}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentCrewPanel({ base, canRun }: { base: string; canRun: boolean }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [runs, setRuns] = useState<CrewRunSummary[]>([]);
  const [open, setOpen] = useState<Record<string, CrewRun>>({});
  const [withPr, setWithPr] = useState<Record<string, boolean>>({});
  const [allRules, setAllRules] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [r, list] = await Promise.all([api<Repo[]>(`${base}/repos`), api<{ runs: CrewRunSummary[] }>(`${base}/crew-runs`)]);
    setRepos(r);
    setRuns(list.runs);
  }, [base]);
  useEffect(() => {
    void refresh().catch((err: Error) => setError(err.message));
  }, [refresh]);

  const runCrew = async (repo: Repo) => {
    setBusy(repo.id);
    setError(null);
    try {
      const run = await api<CrewRun>(`${base}/repos/${repo.id}/crew-runs`, { openPullRequest: repo.source === 'github' && Boolean(withPr[repo.id]), allRules });
      setOpen((o) => ({ ...o, [run.id]: run }));
      await refresh();
      // Shown at once, even if the list was read before the run was stored.
      setRuns((rs) => (rs.some((x) => x.id === run.id) ? rs : [run, ...rs]));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (id: string) => {
    if (open[id]) return setOpen(({ [id]: _closed, ...rest }) => rest);
    try {
      const run = await api<CrewRun>(`${base}/crew-runs/${id}`);
      setOpen((o) => ({ ...o, [id]: run }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section aria-labelledby="crew-heading" className="space-y-3">
      <h2 id="crew-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
        Agent crew
      </h2>
      <p className="text-xs text-zinc-400">
        Six agents check a repository in a chain: the regulation feed picks the rules a new item touches, they are compiled, found in the code, grounded with retrieval, proven
        with Z3, and patched. What one agent passes to the next comes from its tools, never from a model, and a patch must be proven before it becomes a pull request.
      </p>
      {error && (
        <p role="alert" className="rounded px-3 py-2 text-sm bg-rose-950 text-rose-200">
          {error}
        </p>
      )}

      {canRun && (
        <label className="flex items-center gap-1 text-xs text-zinc-300">
          <input type="checkbox" checked={allRules} onChange={(e) => setAllRules(e.target.checked)} />
          Check every rule in effect, not only those today&apos;s feed touches
        </label>
      )}
      {canRun && (
        <ul className="space-y-1">
          {repos.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{r.fullName}</span>
              <button type="button" disabled={busy !== null} onClick={() => void runCrew(r)} className="rounded bg-sky-700 hover:bg-sky-800 text-white px-2 py-0.5 text-xs disabled:opacity-50">
                {busy === r.id ? `Running the agents on ${r.fullName}…` : `Run the agents on ${r.fullName}`}
              </button>
              {r.source === 'github' && (
                <label className="flex items-center gap-1 text-xs text-zinc-300">
                  <input type="checkbox" checked={Boolean(withPr[r.id])} onChange={(e) => setWithPr((w) => ({ ...w, [r.id]: e.target.checked }))} />
                  Open a fix pull request if Z3 proves the patch
                </label>
              )}
            </li>
          ))}
        </ul>
      )}

      <div aria-labelledby="crew-runs-heading" role="region" className="space-y-2">
        <h3 id="crew-runs-heading" className="text-sm font-semibold">
          Recent runs
        </h3>
        {runs.length === 0 && <p className="text-sm text-zinc-400">No runs yet.</p>}
        <ul className="space-y-2">
          {runs.map((run) => {
            const label = `${run.target?.repoFullName ?? 'Sample repository'} at ${commit(run.target?.commitSha)}`;
            return (
              <li key={run.id} aria-label={`Crew run on ${label}`} className="rounded border border-zinc-800 p-2 text-sm space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span>{label}</span>
                  <span className="text-xs text-zinc-400">
                    {when(run.startedAt)} · {(run.latencyMs / 1000).toFixed(1)} s
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${GATE[run.gate].className}`}>{GATE[run.gate].text}</span>
                  <button type="button" onClick={() => void toggle(run.id)} aria-expanded={Boolean(open[run.id])} className="text-xs text-sky-300 underline">
                    {open[run.id] ? `Hide the steps of the run on ${label}` : `Show the steps of the run on ${label}`}
                  </button>
                </p>
                {open[run.id] && <RunDetails run={open[run.id]} />}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
