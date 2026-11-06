import React, { useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, GitBranch, GitPullRequest, Inbox } from 'lucide-react';
import { api, formatDate, shortSha, timeAgo, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Link, Modal, Mono, Notice, PageHeader, RuleKey, Spinner, Table, Tabs, Td, Textarea, Th, cx, useToast } from '../ui';
import { can, type ExceptionRecord, type Finding, type RuleSummary, type ScanRecord } from '../types';
import { conclusionBadge } from './Overview';

const TRIGGER: Record<string, string> = { pull_request: 'Pull request', push: 'Push', manual: 'Rules changed', rerun: 'Re-run', connect: 'Connected', baseline: 'Baseline' };

function Counts({ s }: { s: ScanRecord['summary'] }) {
  if (!s) return <span className="text-zinc-500">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {s.newCount > 0 && <Badge tone="red">{s.newCount} new</Badge>}
      {s.existingCount > 0 && <Badge tone="amber">{s.existingCount} existing</Badge>}
      {s.waivedCount > 0 && <Badge tone="blue">{s.waivedCount} waived</Badge>}
      {s.newCount + s.existingCount + s.waivedCount === 0 && <Badge tone="green">No findings</Badge>}
    </span>
  );
}

export function ChecksPage() {
  const { workspace } = useSession();
  const { data, error } = useApi<ScanRecord[]>(`/workspaces/${workspace.id}/scans?limit=200`, { pollMs: 5000 });
  const [tab, setTab] = useState<'all' | 'pr' | 'branch'>('all');
  const scans = (data ?? []).filter((s) => s.trigger !== 'baseline');
  const shown = scans.filter((s) => (tab === 'pr' ? s.prNumber : tab === 'branch' ? !s.prNumber : true));
  return (
    <>
      <PageHeader title="Checks" description="Every check of a default branch or pull request, with the exact rule versions it used. Pull requests fail only for findings they add." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: 'All', count: scans.length },
          { id: 'pr', label: 'Pull requests', count: scans.filter((s) => s.prNumber).length },
          { id: 'branch', label: 'Default branch', count: scans.filter((s) => !s.prNumber).length },
        ]}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={<GitPullRequest className="size-5" />} title="No checks yet" description="Checks run when a pull request is opened or updated, when the default branch changes, and when Legal approves a rule." />
        </Card>
      ) : (
        <Card padded={false}>
          <Table head={<><Th>Result</Th><Th>Target</Th><Th>Findings</Th><Th>Rules</Th><Th className="text-right">When</Th></>}>
            {shown.map((s) => (
              <tr key={s.id} className="hover:bg-zinc-50">
                <Td>{conclusionBadge(s.conclusion, s.status)}</Td>
                <Td>
                  <Link to={`/app/checks/${s.id}`} className="block">
                    <div className="flex items-center gap-2 font-medium text-zinc-900">
                      {s.prNumber ? <GitPullRequest className="size-4 text-zinc-400" /> : <GitBranch className="size-4 text-zinc-400" />}
                      {s.prNumber ? `Pull request #${s.prNumber}` : 'Default branch'}
                      <Mono className="text-zinc-500">{shortSha(s.commitSha)}</Mono>
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {s.repoFullName} · {TRIGGER[s.trigger] ?? s.trigger}
                    </div>
                  </Link>
                </Td>
                <Td>
                  <Counts s={s.summary} />
                </Td>
                <Td className="text-xs text-zinc-500">{s.ruleVersions.map((r) => `${r.ruleKey} v${r.version}`).join(', ') || '—'}</Td>
                <Td className="whitespace-nowrap text-right text-xs text-zinc-500" >
                  <span title={new Date(s.createdAt).toLocaleString()}>{timeAgo(s.finishedAt ?? s.createdAt)}</span>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

export function CheckDetailPage({ scanId }: { scanId: string }) {
  const { workspace } = useSession();
  const toast = useToast();
  const scan = useApi<ScanRecord & { findings: Finding[] }>(`/workspaces/${workspace.id}/scans/${scanId}`, { pollMs: 6000 });
  const exceptions = useApi<ExceptionRecord[]>(`/workspaces/${workspace.id}/exceptions`, { pollMs: 6000 });
  const rules = useApi<RuleSummary[]>(`/workspaces/${workspace.id}/rule-list`);
  const [asking, setAsking] = useState<Finding | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const titles = useMemo(() => new Map((rules.data ?? []).map((r) => [r.key, r.title])), [rules.data]);
  const byFingerprint = useMemo(() => {
    const m = new Map<string, ExceptionRecord>();
    for (const e of exceptions.data ?? []) if (e.fingerprint && (e.status === 'requested' || e.status === 'approved') && !m.has(e.fingerprint)) m.set(e.fingerprint, e);
    return m;
  }, [exceptions.data]);
  if (scan.error) return <ErrorNote>{scan.error}</ErrorNote>;
  if (!scan.data) return <Spinner />;
  const s = scan.data;
  const gh = `https://github.com/${s.repoFullName}`;
  const groups: Array<{ state: Finding['state']; title: string; hint: string }> = [
    { state: 'new', title: 'New findings', hint: s.prNumber ? 'Added by this pull request. These block merging.' : 'Not on the baseline.' },
    { state: 'existing', title: 'Existing findings', hint: 'Already on the default branch. Reported, not blocking.' },
    { state: 'waived', title: 'Waived', hint: 'Covered by an exception Legal approved.' },
  ];
  const submit = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await api(`/workspaces/${workspace.id}/exceptions`, { body: { scanId: s.id, findingIds: [asking.id], reason } });
      toast('Exception requested. Legal has been notified, and the pull request gets a comment.');
      setAsking(null);
      setReason('');
      await exceptions.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Link to="/app/checks" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
        <ArrowLeft className="size-4" /> Checks
      </Link>
      <PageHeader
        eyebrow={s.repoFullName}
        title={
          <span className="flex items-center gap-3">
            {s.prNumber ? `Pull request #${s.prNumber}` : 'Default branch'} {conclusionBadge(s.conclusion, s.status)}
          </span>
        }
        description={`${TRIGGER[s.trigger] ?? s.trigger} check of ${shortSha(s.commitSha)} · ${formatDate(s.finishedAt ?? s.createdAt, true)}`}
        actions={
          s.repoFullName.includes('/') && (
            <a href={s.prNumber ? `${gh}/pull/${s.prNumber}` : `${gh}/commit/${s.commitSha}`} target="_blank" rel="noreferrer">
              <Button icon={<ExternalLink className="size-4" />}>{s.prNumber ? 'Open on GitHub' : 'View commit'}</Button>
            </a>
          )
        }
      />
      {s.error && (
        <div className="mb-4">
          <ErrorNote>{s.error}</ErrorNote>
        </div>
      )}
      {s.summary?.undecidedRuleKeys.length ? (
        <div className="mb-4">
          <Notice tone="amber">Z3 could not decide {s.summary.undecidedRuleKeys.join(', ')} in time. Those rules are not counted as passing.</Notice>
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-4">
        <div className="space-y-6 lg:col-span-3">
          {groups.map((g) => {
            const items = s.findings.filter((f) => f.state === g.state);
            if (items.length === 0 && g.state !== 'new') return null;
            return (
              <Card key={g.state} title={`${g.title} (${items.length})`} description={g.hint} padded={false}>
                {items.length === 0 ? (
                  <EmptyState title="No new findings" description="This check adds nothing that breaks an approved rule." />
                ) : (
                  <ul className="divide-y divide-zinc-100">
                    {items.map((f) => {
                      const ex = byFingerprint.get(f.fingerprint);
                      return (
                        <li key={f.id} className="flex flex-wrap items-start gap-4 px-5 py-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <RuleKey>{f.ruleKey}</RuleKey>
                              <span className="text-sm font-medium text-zinc-900">{titles.get(f.ruleKey) ?? ''}</span>
                            </div>
                            <a href={s.repoFullName.includes('/') ? `${gh}/blob/${s.commitSha}/${f.filePath}#L${f.startLine}` : undefined} target="_blank" rel="noreferrer" className="mt-1.5 inline-block font-mono text-[0.8rem] text-indigo-700 hover:underline">
                              {f.filePath}:{f.startLine}
                            </a>
                            <p className="mt-1 text-sm text-zinc-600">{f.message}</p>
                          </div>
                          <div className="shrink-0">
                            {ex ? (
                              ex.status === 'approved' ? (
                                <Badge tone="blue" title={ex.decisionNote ?? ''}>Waived until {formatDate(ex.expiresAt)}</Badge>
                              ) : (
                                <Link to="/app/exceptions">
                                  <Badge tone="amber" dot>Exception requested</Badge>
                                </Link>
                              )
                            ) : (
                              f.state !== 'waived' &&
                              can(workspace.role, 'requestExceptions') && (
                                <Button size="sm" icon={<Inbox className="size-3.5" />} onClick={() => setAsking(f)}>
                                  Request exception
                                </Button>
                              )
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
        <Card title="Details" className="h-fit">
          <dl className="space-y-3 text-sm">
            {[
              ['Commit', <Mono key="c">{shortSha(s.commitSha)}</Mono>],
              ['Compared with', s.baseSha ? <Mono key="b">{shortSha(s.baseSha)}</Mono> : 'No baseline (default branch)'],
              ['Files read', s.filesScanned ?? '—'],
              ['Rules', s.ruleVersions.map((r) => `${r.ruleKey} v${r.version}`).join(', ') || 'None in effect'],
              ['Engine', <Mono key="e" className="break-all text-xs">{s.lexcompilerVersion}</Mono>],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt className="text-xs text-zinc-500">{k}</dt>
                <dd className={cx('mt-0.5 text-zinc-800')}>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500">The code was parsed, never run. Re-running this commit with the same rule versions gives the same result.</p>
        </Card>
      </div>
      <Modal
        open={Boolean(asking)}
        title="Request an exception"
        description="Legal decides. If they approve, the finding is waived until the date they set, and the check re-runs."
        onClose={() => setAsking(null)}
        footer={
          <>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={reason.trim().length < 10} onClick={submit}>
              Send to Legal
            </Button>
          </>
        }
      >
        {asking && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
            <RuleKey>{asking.ruleKey}</RuleKey> <Mono className="ml-1">{asking.filePath}:{asking.startLine}</Mono>
            <p className="mt-1 text-zinc-600">{asking.message}</p>
          </div>
        )}
        <Field label="Why is this acceptable for now?" htmlFor="reason" hint="Say what makes it safe today and when it will be fixed.">
          <Textarea id="reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The endpoint stores nothing yet; storage arrives with LN-12, which adds tenant keys." />
        </Field>
      </Modal>
    </>
  );
}
