import React from 'react';
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, CircleDot, FileCheck2, GitBranch, GitPullRequest, Inbox, Scale, Sparkles, XCircle } from 'lucide-react';
import { shortSha, timeAgo, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Badge, Button, Card, EmptyState, ErrorNote, Link, Mono, Notice, PageHeader, Spinner, Stat, cx } from '../ui';
import { can, type Activity, type Overview } from '../types';

export function conclusionBadge(conclusion: string | null, status?: string) {
  if (status && status !== 'completed') return status === 'failed' ? <Badge tone="red" dot>Error</Badge> : <Badge tone="blue" dot>Running</Badge>;
  switch (conclusion) {
    case 'success':
      return <Badge tone="green" dot>Passing</Badge>;
    case 'failure':
      return <Badge tone="red" dot>Failing</Badge>;
    case 'action_required':
      return <Badge tone="amber" dot>Needs review</Badge>;
    case 'neutral':
      return <Badge tone="gray" dot>Reported</Badge>;
    default:
      return <Badge tone="gray" dot>{conclusion ?? 'Pending'}</Badge>;
  }
}

const ACTIVITY_ICON: Record<string, React.ReactNode> = {
  rule: <Scale className="size-4 text-indigo-500" />,
  'check-failed': <XCircle className="size-4 text-rose-500" />,
  'check-passed': <CheckCircle2 className="size-4 text-emerald-500" />,
  scan: <GitBranch className="size-4 text-zinc-500" />,
  exception: <Inbox className="size-4 text-amber-500" />,
  'exception-approved': <CheckCircle2 className="size-4 text-emerald-500" />,
  share: <FileCheck2 className="size-4 text-sky-500" />,
  assistant: <Bot className="size-4 text-violet-500" />,
};

export function ActivityList({ items }: { items: Activity[] }) {
  if (items.length === 0) return <EmptyState title="Nothing yet" description="Rule decisions, checks, exceptions and assistant calls show up here." />;
  return (
    <ol className="divide-y divide-zinc-100">
      {items.map((a, i) => {
        const body = (
          <div className="flex items-start gap-3 px-5 py-3">
            <span className="mt-0.5 shrink-0">{ACTIVITY_ICON[a.kind] ?? <CircleDot className="size-4 text-zinc-400" />}</span>
            <span className="min-w-0 flex-1 text-sm text-zinc-700">{a.text}</span>
            <span className="shrink-0 text-xs text-zinc-500" title={new Date(a.at).toLocaleString()}>
              {timeAgo(a.at)}
            </span>
          </div>
        );
        return <li key={`${a.at}-${i}`}>{a.link ? <Link to={a.link} className="block hover:bg-zinc-50">{body}</Link> : body}</li>;
      })}
    </ol>
  );
}

export function OverviewPage() {
  const { workspace, me } = useSession();
  const { data, error } = useApi<Overview>(`/workspaces/${workspace.id}/overview`, { pollMs: 5000 });
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const c = data.counts;
  const open = data.repos.reduce((n, r) => n + (r.lastScan?.summary ? r.lastScan.summary.newCount + r.lastScan.summary.existingCount : 0), 0);
  const prs = data.repos.flatMap((r) => r.pullRequests);
  const failingPrs = prs.filter((p) => p.conclusion === 'failure').length;
  const firstName = (me.name ?? '').split(' ')[0];
  return (
    <>
      <PageHeader
        eyebrow={firstName ? `Welcome back, ${firstName}` : undefined}
        title={data.workspace.name}
        description={`${data.repos.length} connected repositor${data.repos.length === 1 ? 'y' : 'ies'} · ${c.members} members · ${data.workspace.planLabel} plan`}
        actions={
          can(data.role, 'editRules') ? (
            <Link to="/app/rules/new">
              <Button variant="primary" icon={<Scale className="size-4" />}>
                New rule from a clause
              </Button>
            </Link>
          ) : undefined
        }
      />

      {c.exceptionsWaiting > 0 && (
        <div className="mb-6">
          <Notice
            tone="amber"
            icon={<AlertTriangle className="size-4" />}
            action={
              <Link to="/app/exceptions">
                <Button size="sm">{can(data.role, 'decideExceptions') ? 'Review' : 'View'}</Button>
              </Link>
            }
          >
            <strong className="font-semibold">{c.exceptionsWaiting} exception request{c.exceptionsWaiting === 1 ? ' is' : 's are'} waiting for Legal.</strong>{' '}
            {can(data.role, 'decideExceptions') ? 'The pull request stays blocked until you decide.' : 'Legal decides; the check re-runs on approval.'}
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Rules in effect" value={c.rulesInEffect} icon={<Scale className="size-4" />} hint={c.drafts ? `${c.drafts} draft${c.drafts === 1 ? '' : 's'} waiting for approval` : c.scheduled ? `${c.scheduled} scheduled` : 'Approved by Legal'} />
        <Stat label="Pull requests failing" value={`${failingPrs}`} tone={failingPrs ? 'red' : 'green'} icon={<GitPullRequest className="size-4" />} hint={`${prs.length} checked · only new findings block`} />
        <Stat label="Open on default branches" value={open} tone={open ? 'amber' : 'green'} icon={<GitBranch className="size-4" />} hint="Existing findings, reported, not blocking" />
        <Stat
          label="AI usage today"
          value={c.aiMode === 'off' ? 'Off' : c.aiTokensToday.toLocaleString()}
          icon={<Sparkles className="size-4" />}
          hint={c.aiMode === 'off' ? 'Turn it on in Settings' : `tokens of ${c.aiDailyBudget.toLocaleString()} · ${c.aiMode === 'cloud' ? 'cloud model' : 'local model'}`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card title="Repositories" description="The latest check of each default branch and pull request." padded={false}>
            {data.repos.length === 0 ? (
              <EmptyState icon={<GitBranch className="size-5" />} title="No repositories yet" description="A workspace owner connects repositories by installing the LexCompiler GitHub App." />
            ) : (
              <div className="divide-y divide-zinc-100">
                {data.repos.map((r) => (
                  <div key={r.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-900">{r.fullName}</span>
                      {r.source === 'github' && (
                        <a href={`https://github.com/${r.fullName}`} target="_blank" rel="noreferrer" className="text-xs text-zinc-500 hover:text-indigo-600">
                          GitHub ↗
                        </a>
                      )}
                    </div>
                    <div className="mt-3 space-y-2">
                      {r.lastScan ? (
                        <Link to={`/app/checks/${r.lastScan.id}`} className="flex items-center gap-3 rounded-lg border border-zinc-100 px-3 py-2 hover:bg-zinc-50">
                          <GitBranch className="size-4 text-zinc-400" />
                          <span className="text-sm text-zinc-700">{r.defaultBranch}</span>
                          <Mono className="text-zinc-500">{shortSha(r.lastScan.commitSha)}</Mono>
                          <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
                            {r.lastScan.summary && `${r.lastScan.summary.existingCount + r.lastScan.summary.newCount} open`}
                            {conclusionBadge(r.lastScan.conclusion)}
                          </span>
                        </Link>
                      ) : (
                        <div className="rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-sm text-zinc-500">{r.defaultBranch} hasn't been scanned with these rules yet.</div>
                      )}
                      {r.pullRequests.map((p) => (
                        <Link key={p.scanId} to={`/app/checks/${p.scanId}`} className="flex items-center gap-3 rounded-lg border border-zinc-100 px-3 py-2 hover:bg-zinc-50">
                          <GitPullRequest className={cx('size-4', p.conclusion === 'failure' ? 'text-rose-500' : 'text-emerald-500')} />
                          <span className="text-sm text-zinc-700">Pull request #{p.prNumber}</span>
                          <Mono className="text-zinc-500">{shortSha(p.commitSha)}</Mono>
                          <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
                            {p.summary && p.summary.newCount > 0 && `${p.summary.newCount} new`}
                            {p.summary && p.summary.waivedCount > 0 && `${p.summary.waivedCount} waived`}
                            {conclusionBadge(p.conclusion, p.status)}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Exceptions in force" value={c.exceptionsActive} icon={<Inbox className="size-4" />} hint="Each with an expiry date" />
            <Stat label="Evidence records" value={c.evidenceRecords} icon={<FileCheck2 className="size-4" />} hint="Signed, hash-chained" />
            <Stat label="Assistant calls today" value={c.assistantCallsToday} icon={<Bot className="size-4" />} hint="From coding assistants over MCP" />
          </div>
        </div>

        <Card
          className="lg:col-span-2"
          title="Activity"
          description="Updates every few seconds."
          padded={false}
          actions={
            <Link to="/app/evidence" className="flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              Evidence <ArrowRight className="size-3.5" />
            </Link>
          }
        >
          <ActivityList items={data.activity} />
        </Card>
      </div>
    </>
  );
}
