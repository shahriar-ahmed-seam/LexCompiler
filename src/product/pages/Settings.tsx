import React, { useEffect, useState } from 'react';
import { Cloud, Cpu, ExternalLink, PowerOff } from 'lucide-react';
import { api, timeAgo, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Avatar, Badge, Button, Card, EmptyState, Field, Input, Mono, Notice, PageHeader, Select, Spinner, Table, Tabs, Td, Th, cx, useToast } from '../ui';
import { can, ROLE_LABEL, type Role } from '../types';

type Tab = 'members' | 'ai' | 'github' | 'plan';

interface AiStatus {
  mode: 'off' | 'local' | 'cloud';
  dailyTokenBudget: number;
  updatedAt: string | null;
  tokensUsedToday: number;
  models: { local: string; cloud: string | null };
}
interface AiCall {
  id: string;
  task: string;
  mode: string;
  model: string;
  endpointHost: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: string;
  createdAt: string;
}
interface Usage {
  planLabel: string;
  seats: { used: number; limit: number };
  repos: { used: number; limit: number };
  ai: { mode: string; today: number; month: number; dailyBudget: number; callsMonth: number };
  assistantCalls: { today: number; month: number };
  evidenceRecords: number;
}

function Meter({ label, used, limit, hint }: { label: string; used: number; limit: number; hint?: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-zinc-800">{label}</span>
        <span className="text-zinc-500">
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
        <div className={cx('h-full rounded-full', pct > 85 ? 'bg-amber-500' : 'bg-indigo-500')} style={{ width: `${pct}%` }} />
      </div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function SettingsPage() {
  const params = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'members');
  return (
    <>
      <PageHeader title="Settings" description="Members and roles, where AI runs, the GitHub connection, and your plan." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'members', label: 'Members' },
          { id: 'ai', label: 'AI' },
          { id: 'github', label: 'GitHub' },
          { id: 'plan', label: 'Plan and usage' },
        ]}
      />
      {tab === 'members' && <Members />}
      {tab === 'ai' && <AiSettings />}
      {tab === 'github' && <GitHub />}
      {tab === 'plan' && <Plan />}
    </>
  );
}

function Members() {
  const { workspace } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<{ members: Array<{ userId: string; email: string | null; name: string | null; role: Role }>; invitations: Array<{ email: string; role: Role; acceptedAt: string | null }> }>(`/workspaces/${workspace.id}/members`);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('engineer');
  const owner = can(workspace.role, 'manageWorkspace');
  const invite = async () => {
    try {
      await api(`/workspaces/${workspace.id}/members`, { body: { email, role } });
      toast(`${email} invited as ${ROLE_LABEL[role]}.`);
      setEmail('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    }
  };
  if (!data) return <Spinner />;
  return (
    <div className="space-y-6">
      <Card title="Members" description="Roles keep duties apart: Legal approves rules and exceptions; whoever merges code cannot." padded={false}>
        <Table head={<><Th>Person</Th><Th>Role</Th><Th>Can</Th></>}>
          {data.members.map((m) => (
            <tr key={m.userId}>
              <Td>
                <div className="flex items-center gap-3">
                  <Avatar name={m.name ?? m.email} />
                  <div>
                    <div className="font-medium text-zinc-900">{m.name ?? m.email}</div>
                    <div className="text-xs text-zinc-500">{m.email}</div>
                  </div>
                </div>
              </Td>
              <Td>
                <Badge tone={m.role === 'legal' ? 'violet' : m.role === 'owner' ? 'indigo' : m.role === 'engineer' ? 'blue' : 'gray'}>{ROLE_LABEL[m.role]}</Badge>
              </Td>
              <Td className="text-zinc-600">
                {m.role === 'owner' && 'Connect repositories, manage members, set AI, share evidence'}
                {m.role === 'legal' && 'Approve rules, decide exceptions, share evidence'}
                {m.role === 'engineer' && 'Run checks, request exceptions, connect a coding assistant'}
                {m.role === 'viewer' && 'Read everything'}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {owner && (
        <Card title="Invite someone" description="They join when they first sign in with this email address.">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1">
              <Field label="Email" htmlFor="invite-email">
                <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
              </Field>
            </div>
            <Field label="Role" htmlFor="invite-role">
              <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-40">
                {(['owner', 'legal', 'engineer', 'viewer'] as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="primary" disabled={!email.includes('@')} onClick={invite}>
              Send invitation
            </Button>
          </div>
          {data.invitations.filter((i) => !i.acceptedAt).length > 0 && <div className="mt-4 text-sm text-zinc-500">Pending: {data.invitations.filter((i) => !i.acceptedAt).map((i) => `${i.email} (${ROLE_LABEL[i.role]})`).join(', ')}</div>}
        </Card>
      )}
    </div>
  );
}

function AiSettings() {
  const { workspace } = useSession();
  const toast = useToast();
  const status = useApi<AiStatus>(`/workspaces/${workspace.id}/ai`);
  const calls = useApi<AiCall[]>(`/workspaces/${workspace.id}/ai/calls?limit=30`, { pollMs: 8000 });
  const [mode, setMode] = useState<AiStatus['mode']>('off');
  const [budget, setBudget] = useState('');
  useEffect(() => {
    if (status.data) {
      setMode(status.data.mode);
      setBudget(String(status.data.dailyTokenBudget));
    }
  }, [status.data]);
  const owner = can(workspace.role, 'manageWorkspace');
  if (!status.data) return <Spinner />;
  const options: Array<{ id: AiStatus['mode']; title: string; icon: React.ReactNode; body: string; model?: string | null }> = [
    { id: 'off', title: 'Off', icon: <PowerOff className="size-4" />, body: 'No model sees your contracts or code. Rule cards use the parser only.' },
    { id: 'local', title: 'Local model', icon: <Cpu className="size-4" />, body: 'A model on your own server reads clauses. Nothing leaves your infrastructure.', model: status.data.models.local },
    { id: 'cloud', title: 'Cloud model', icon: <Cloud className="size-4" />, body: 'A hosted model reads one clause at a time to draft rule cards. Code is never sent.', model: status.data.models.cloud },
  ];
  const save = async () => {
    try {
      await api(`/workspaces/${workspace.id}/ai`, { method: 'PUT', body: { mode, dailyTokenBudget: Number(budget) } });
      toast('AI settings saved.');
      await status.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    }
  };
  return (
    <div className="space-y-6">
      <Card title="Where AI runs" description="AI only proposes. A value reaches the rule card only if its quote is in the clause and the parser agrees, and Legal approves every rule. Pull-request checks never call a model.">
        <div className="grid gap-3 md:grid-cols-3">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={!owner || (o.id === 'cloud' && !o.model)}
              onClick={() => setMode(o.id)}
              className={cx('rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60', mode === o.id ? 'border-indigo-500 bg-indigo-50/50 ring-3 ring-indigo-500/10' : 'cursor-pointer border-zinc-200 hover:border-zinc-300')}
            >
              <div className="flex items-center gap-2 font-medium text-zinc-900">
                {o.icon} {o.title}
              </div>
              <p className="mt-1.5 text-sm text-zinc-600">{o.body}</p>
              {o.id !== 'off' && <div className="mt-2 font-mono text-xs text-zinc-500">{o.model ?? 'No model configured on the server'}</div>}
            </button>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-4">
          <Field label="Daily token budget" htmlFor="budget" hint={`${status.data.tokensUsedToday.toLocaleString()} used today. Calls stop for the day at the limit.`}>
            <Input id="budget" type="number" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={!owner} className="w-44" />
          </Field>
          {owner ? (
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          ) : (
            <span className="pb-2 text-sm text-zinc-500">Only the workspace owner can change this.</span>
          )}
        </div>
      </Card>
      <Card title="Model calls" description="Every call, with the model and tokens. Prompts are not stored; only their SHA-256." padded={false}>
        {!calls.data?.length ? (
          <EmptyState title="No model calls yet" />
        ) : (
          <Table head={<><Th>Task</Th><Th>Model</Th><Th>Tokens</Th><Th>Latency</Th><Th>Result</Th><Th className="text-right">When</Th></>}>
            {calls.data.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium text-zinc-900">{c.task}</Td>
                <Td>
                  <Mono>{c.model}</Mono>
                  <div className="text-xs text-zinc-500">{c.endpointHost}</div>
                </Td>
                <Td>{(c.inputTokens + c.outputTokens).toLocaleString()}</Td>
                <Td>{(c.latencyMs / 1000).toFixed(1)} s</Td>
                <Td>{c.outcome === 'ok' ? <Badge tone="green">ok</Badge> : <Badge tone="amber">{c.outcome}</Badge>}</Td>
                <Td className="whitespace-nowrap text-right text-xs text-zinc-500">{timeAgo(c.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function GitHub() {
  const { workspace } = useSession();
  const installs = useApi<Array<{ installationId: number; accountLogin: string; accountType: string; repos: Array<{ id: string; fullName: string; defaultBranch: string }> }>>(`/workspaces/${workspace.id}/github`);
  const app = useApi<{ configured: boolean; name: string | null; htmlUrl: string | null }>('/github/app');
  if (!installs.data) return <Spinner />;
  return (
    <Card
      title="GitHub"
      description="The LexCompiler GitHub App checks pull requests and pushes in these repositories. It reads code, writes check runs and comments, and never runs your code."
      actions={
        app.data?.htmlUrl && (
          <a href={app.data.htmlUrl} target="_blank" rel="noreferrer">
            <Button icon={<ExternalLink className="size-4" />}>{app.data.name ?? 'GitHub App'}</Button>
          </a>
        )
      }
    >
      {installs.data.length === 0 ? (
        <EmptyState title="GitHub isn't connected" description="A workspace owner installs the LexCompiler GitHub App on the organization or account." />
      ) : (
        installs.data.map((i) => (
          <div key={i.installationId}>
            <div className="text-sm text-zinc-500">
              Installed on <span className="font-medium text-zinc-800">{i.accountLogin}</span> ({i.accountType}) · installation {i.installationId}
            </div>
            <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {i.repos.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <a href={`https://github.com/${r.fullName}`} target="_blank" rel="noreferrer" className="font-medium text-zinc-900 hover:text-indigo-600">
                    {r.fullName}
                  </a>
                  <span className="text-zinc-500">
                    default branch <Mono>{r.defaultBranch}</Mono>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <div className="mt-5">
        <Notice tone="gray">
          To block merges until the check passes, add a branch ruleset in the repository: Settings → Rules → require the status check <Mono>LexCompiler / compliance</Mono>.
        </Notice>
      </div>
    </Card>
  );
}

function Plan() {
  const { workspace } = useSession();
  const { data } = useApi<Usage>(`/workspaces/${workspace.id}/usage`);
  if (!data) return <Spinner />;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <div className="text-sm text-zinc-500">Current plan</div>
        <div className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight text-zinc-900">
          {data.planLabel} <Badge tone="indigo">Active</Badge>
        </div>
        <p className="mt-2 text-sm text-zinc-600">The pilot includes every feature: GitHub checks, the rule workspace, exceptions, signed evidence and the coding-assistant server.</p>
        <p className="mt-4 text-xs text-zinc-500">Workspace {workspace.name}</p>
      </Card>
      <Card title="Usage" className="lg:col-span-2">
        <div className="grid gap-6 sm:grid-cols-2">
          <Meter label="Seats" used={data.seats.used} limit={data.seats.limit} />
          <Meter label="Repositories" used={data.repos.used} limit={data.repos.limit} />
          <Meter label="AI tokens today" used={data.ai.today} limit={data.ai.dailyBudget} hint={`${data.ai.month.toLocaleString()} this month in ${data.ai.callsMonth} calls · AI ${data.ai.mode}`} />
          <div className="space-y-1 text-sm">
            <div className="font-medium text-zinc-800">This month</div>
            <div className="text-zinc-600">{data.assistantCalls.month} coding-assistant calls ({data.assistantCalls.today} today)</div>
            <div className="text-zinc-600">{data.evidenceRecords} signed evidence records</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
