import { useState } from 'react';
import { Bot } from 'lucide-react';
import { api, shortSha, timeAgo, useApi } from './api';
import { Badge, Button, Card, EmptyState, ErrorNote, Mono, Notice, Spinner, Table, Td, Th } from './ui';
import type { CrewGate, CrewRun, CrewRunSummary, CrewStep } from './types';

const GATE: Record<CrewGate, { text: string; tone: 'green' | 'amber' | 'red' }> = {
  NOTHING_TO_FIX: { text: 'Nothing to fix', tone: 'green' },
  PATCH_VERIFIED: { text: 'Patch proven by Z3', tone: 'green' },
  PATCH_BLOCKED: { text: 'Patch not proven', tone: 'amber' },
  INCOMPLETE: { text: 'A step failed', tone: 'red' },
};

const commit = (sha?: string) => (!sha ? '' : sha === 'working-tree' ? 'working tree' : shortSha(sha));

interface ModelFix {
  ruleKey: string;
  path: string;
  startLine: number;
  endLine: number;
  body: string;
}

function RunDetails({ run }: { run: CrewRun }) {
  const handoff = (run.steps[5]?.handoff ?? {}) as Record<string, unknown>;
  const pr = handoff.pullRequest as { prNumber: number; url: string; created: boolean } | undefined;
  const prError = handoff.pullRequestError as string | undefined;
  const modelFixes = (handoff.modelFixes as ModelFix[] | undefined) ?? [];
  return (
    <div className="space-y-3">
      <ol className="space-y-1 text-sm">
        {run.steps.map((s: CrewStep) => (
          <li
            key={s.stepNumber}
            aria-label={`Step ${s.stepNumber}: ${s.agentName}`}
            className={s.status === 'SKIPPED' ? 'text-zinc-400' : s.status === 'FAILED' ? 'text-rose-700' : 'text-zinc-700'}
          >
            <span className="font-medium text-zinc-900">
              {s.stepNumber}. {s.agentName}
            </span>{' '}
            <span className="text-zinc-400">({s.pythonAdapter})</span>: {s.summary}
            {s.error && <span> {s.error}</span>}
          </li>
        ))}
      </ol>
      {pr && (
        <p className="text-sm text-emerald-700">
          {pr.created ? 'Opened' : 'Already open for this commit:'}{' '}
          <a className="text-indigo-700 underline" href={pr.url} target="_blank" rel="noreferrer">
            pull request #{pr.prNumber}
          </a>
        </p>
      )}
      {prError && <Notice tone="amber">No pull request: {prError}</Notice>}
      {modelFixes.length > 0 && (
        <div aria-label="Fix agent suggestions" role="region" className="space-y-1">
          <p className="text-sm text-zinc-600">Fix agent: model-written fixes that parse and that Z3 confirms. Review them; nothing was committed.</p>
          {modelFixes.map((f) => (
            <details key={`${f.path}:${f.startLine}`} className="text-sm">
              <summary className="cursor-pointer text-indigo-700">
                {f.ruleKey} at {f.path}:{f.startLine}
                {f.endLine > f.startLine ? `–${f.endLine}` : ''}
              </summary>
              <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-2 font-mono text-xs text-zinc-800">{f.body}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only list of the workspace's agent-crew runs (steps and handoffs on demand). */
export function CrewRunsPanel({ workspaceId }: { workspaceId: string }) {
  const { data, error } = useApi<{ runs: CrewRunSummary[] }>(`/workspaces/${workspaceId}/crew-runs`, { pollMs: 10000 });
  const [open, setOpen] = useState<Record<string, CrewRun>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = async (run: CrewRunSummary) => {
    if (open[run.id]) {
      setOpen(({ [run.id]: _closed, ...rest }) => rest);
      return;
    }
    setBusy(run.id);
    setDetailError(null);
    try {
      const full = await api<CrewRun>(`/workspaces/${workspaceId}/crew-runs/${run.id}`);
      setOpen((o) => ({ ...o, [run.id]: full }));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const runs = data.runs;
  if (runs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Bot className="size-5" />}
          title="No agent runs yet"
          description="The six-agent crew checks a repository end to end — feed watch, compilation, code locations, retrieval, Z3 proof, and a patch it can open as a proven fix pull request. Runs start from the legal workspace."
        />
      </Card>
    );
  }
  return (
    <Card padded={false}>
      {detailError && (
        <div className="border-b border-zinc-100 px-5 py-3">
          <ErrorNote>{detailError}</ErrorNote>
        </div>
      )}
      <Table
        head={
          <>
            <Th>Run</Th>
            <Th>Result</Th>
            <Th>Tokens</Th>
            <Th>Duration</Th>
            <Th className="text-right">When</Th>
            <Th />
          </>
        }
      >
        {runs.map((run) => {
          const g = GATE[run.gate];
          const expanded = Boolean(open[run.id]);
          return [
            <tr key={run.id} className="hover:bg-zinc-50">
              <Td>
                <div className="font-medium text-zinc-900">
                  {run.target?.repoFullName ?? 'Sample repository'} at <Mono className="text-zinc-500">{commit(run.target?.commitSha)}</Mono>
                </div>
                {run.triggeredBy && <div className="mt-0.5 text-xs text-zinc-500">by {run.triggeredBy}</div>}
              </Td>
              <Td>{run.status === 'FAILED' ? <Badge tone="red">Failed</Badge> : <Badge tone={g.tone}>{g.text}</Badge>}</Td>
              <Td className="text-xs text-zinc-500">{run.totalTokens ?? '—'}</Td>
              <Td className="whitespace-nowrap text-xs text-zinc-500">{(run.latencyMs / 1000).toFixed(1)} s</Td>
              <Td className="whitespace-nowrap text-right text-xs text-zinc-500">
                <span title={new Date(run.finishedAt ?? run.startedAt).toLocaleString()}>{timeAgo(run.finishedAt ?? run.startedAt)}</span>
              </Td>
              <Td className="text-right">
                <Button size="sm" loading={busy === run.id} aria-expanded={expanded} onClick={() => void toggle(run)}>
                  {expanded ? 'Hide steps' : 'Show steps'}
                </Button>
              </Td>
            </tr>,
            expanded && (
              <tr key={`${run.id}-detail`} className="bg-zinc-50/60">
                <td colSpan={6} className="px-5 py-4">
                  <RunDetails run={open[run.id]} />
                </td>
              </tr>
            ),
          ];
        })}
      </Table>
    </Card>
  );
}
