import React, { useState } from 'react';
import { Bot, GitPullRequest, Inbox, LayoutDashboard } from 'lucide-react';
import { api, formatDate, timeAgo, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Link, Modal, Mono, Notice, PageHeader, RuleKey, Spinner, Tabs, Textarea, useToast } from '../ui';
import { can, type ExceptionRecord } from '../types';

const VIA: Record<string, { label: string; icon: React.ReactNode }> = {
  github: { label: 'GitHub', icon: <GitPullRequest className="size-3.5" /> },
  mcp: { label: 'coding assistant', icon: <Bot className="size-3.5" /> },
  dashboard: { label: 'LexCompiler', icon: <LayoutDashboard className="size-3.5" /> },
};

const STATUS: Record<ExceptionRecord['status'], React.ReactNode> = {
  requested: <Badge tone="amber" dot>Waiting for Legal</Badge>,
  approved: <Badge tone="blue" dot>Approved</Badge>,
  rejected: <Badge tone="red">Rejected</Badge>,
  expired: <Badge tone="gray">Expired</Badge>,
  revoked: <Badge tone="gray">Revoked</Badge>,
};

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

export function ExceptionsPage() {
  const { workspace } = useSession();
  const toast = useToast();
  const { data, error, reload } = useApi<ExceptionRecord[]>(`/workspaces/${workspace.id}/exceptions`, { pollMs: 5000 });
  const [tab, setTab] = useState<'waiting' | 'active' | 'closed'>('waiting');
  const [deciding, setDeciding] = useState<{ e: ExceptionRecord; decision: 'approve' | 'reject' | 'revoke' } | null>(null);
  const [until, setUntil] = useState(inDays(30));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const legal = can(workspace.role, 'decideExceptions');
  const all = data ?? [];
  const lists = {
    waiting: all.filter((e) => e.status === 'requested'),
    active: all.filter((e) => e.status === 'approved'),
    closed: all.filter((e) => ['rejected', 'expired', 'revoked'].includes(e.status)),
  };
  const open = (e: ExceptionRecord, decision: 'approve' | 'reject' | 'revoke') => {
    setDeciding({ e, decision });
    setNote('');
    setUntil(inDays(30));
  };
  const submit = async () => {
    if (!deciding) return;
    setBusy(true);
    try {
      const { e, decision } = deciding;
      await api(`/workspaces/${workspace.id}/exceptions/${e.id}/${decision}`, { body: decision === 'approve' ? { expiresAt: new Date(`${until}T23:59:59`).toISOString(), note } : { note } });
      toast(
        decision === 'approve'
          ? `Exception to ${e.ruleKey} approved until ${formatDate(new Date(`${until}T23:59:59`).toISOString())}. The pull request check is re-running.`
          : decision === 'reject'
            ? `Exception to ${e.ruleKey} rejected. The finding still blocks.`
            : `Exception to ${e.ruleKey} revoked. Checks will fail again.`
      );
      setDeciding(null);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    } finally {
      setBusy(false);
    }
  };
  const list = lists[tab];
  return (
    <>
      <PageHeader title="Exceptions" description="Requests to accept a finding for a limited time. Engineers ask from GitHub, a coding assistant or LexCompiler; only Legal decides, and every decision expires." />
      {!legal && (
        <div className="mb-4">
          <Notice tone="gray">You can see every request. Only people with the Legal role can approve or reject them.</Notice>
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'waiting', label: 'Waiting', count: lists.waiting.length },
          { id: 'active', label: 'In force', count: lists.active.length },
          { id: 'closed', label: 'Closed', count: lists.closed.length },
        ]}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="size-5" />} title={tab === 'waiting' ? 'No requests waiting' : tab === 'active' ? 'No exceptions in force' : 'Nothing closed yet'} description={tab === 'waiting' ? `When a pull request breaks a rule and can’t be fixed yet, the engineer asks here, and ${legal ? 'you decide' : 'Legal decides'}.` : undefined} />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((e) => (
            <Card key={e.id}>
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {e.ruleKey && <RuleKey>{e.ruleKey}</RuleKey>}
                    <span className="font-medium text-zinc-900">{e.ruleTitle}</span>
                    {STATUS[e.status]}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-600">
                    {e.filePath && (
                      <Mono className="text-zinc-800">
                        {e.filePath}:{e.startLine}
                      </Mono>
                    )}
                    {e.repoFullName && <span>{e.repoFullName}</span>}
                    {e.prNumber && e.repoFullName && (
                      <a href={`https://github.com/${e.repoFullName}/pull/${e.prNumber}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                        Pull request #{e.prNumber}
                      </a>
                    )}
                    {e.scanId && (
                      <Link to={`/app/checks/${e.scanId}`} className="text-indigo-600 hover:underline">
                        Check
                      </Link>
                    )}
                  </div>
                  {e.message && <p className="mt-1 text-sm text-zinc-500">{e.message}</p>}
                  <blockquote className="mt-3 rounded-lg border-l-2 border-amber-300 bg-amber-50/50 px-3 py-2 text-sm text-zinc-800">“{e.reason}”</blockquote>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    {VIA[e.requestedFrom ?? '']?.icon}
                    Requested by <span className="font-medium text-zinc-700">{e.requesterLabel}</span> from {VIA[e.requestedFrom ?? '']?.label ?? 'LexCompiler'} · {timeAgo(e.requestedAt)}
                  </div>
                  {e.decidedAt && (
                    <div className="mt-1 text-xs text-zinc-500">
                      {e.status === 'rejected' ? 'Rejected' : e.status === 'revoked' ? 'Revoked' : 'Approved'} by <span className="font-medium text-zinc-700">{e.decidedByName ?? 'Legal'}</span> · {formatDate(e.decidedAt, true)}
                      {e.expiresAt && ` · ${e.status === 'approved' ? 'until' : 'was until'} ${formatDate(e.expiresAt)}`}
                      {e.decisionNote && <> · “{e.decisionNote}”</>}
                    </div>
                  )}
                </div>
                {legal && (
                  <div className="flex shrink-0 gap-2">
                    {e.status === 'requested' && (
                      <>
                        <Button variant="danger" onClick={() => open(e, 'reject')}>
                          Reject
                        </Button>
                        <Button variant="success" onClick={() => open(e, 'approve')}>
                          Approve
                        </Button>
                      </>
                    )}
                    {e.status === 'approved' && <Button onClick={() => open(e, 'revoke')}>Revoke</Button>}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={Boolean(deciding)}
        title={deciding?.decision === 'approve' ? `Approve an exception to ${deciding.e.ruleKey}` : deciding?.decision === 'reject' ? 'Reject this request' : 'Revoke this exception'}
        description={deciding?.decision === 'approve' ? 'The finding is waived until the date you choose. The decision is signed and goes into the evidence log.' : 'The finding will block the pull request again.'}
        onClose={() => setDeciding(null)}
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>Cancel</Button>
            <Button variant={deciding?.decision === 'approve' ? 'success' : 'danger'} loading={busy} onClick={submit}>
              {deciding?.decision === 'approve' ? 'Approve exception' : deciding?.decision === 'reject' ? 'Reject request' : 'Revoke'}
            </Button>
          </>
        }
      >
        {deciding?.decision === 'approve' && (
          <Field label="Waived until" htmlFor="until" hint="Required. Exceptions last at most a year.">
            <div className="flex flex-wrap items-center gap-2">
              <Input id="until" type="date" value={until} min={inDays(1)} max={inDays(365)} onChange={(ev) => setUntil(ev.target.value)} className="w-44" />
              {[7, 30, 90].map((d) => (
                <Button key={d} size="sm" variant="ghost" onClick={() => setUntil(inDays(d))}>
                  {d} days
                </Button>
              ))}
            </div>
          </Field>
        )}
        <Field label={deciding?.decision === 'approve' ? 'Conditions or reason' : 'Reason'} htmlFor="note">
          <Textarea id="note" rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder={deciding?.decision === 'approve' ? 'Accepted until LN-12 adds tenant-key storage.' : 'Fix it before merging: the endpoint handles patient data.'} />
        </Field>
      </Modal>
    </>
  );
}
