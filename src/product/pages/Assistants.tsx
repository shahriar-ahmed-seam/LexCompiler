import React, { useState } from 'react';
import { Bot, KeyRound, ShieldCheck } from 'lucide-react';
import { api, formatDate, timeAgo, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Badge, Button, Card, CodeBlock, CopyButton, EmptyState, Field, Input, Mono, Notice, PageHeader, Select, Table, Td, Th, cx, useToast } from '../ui';
import type { AssistantCall, TokenRecord } from '../types';

const TOOLS: Array<[string, string]> = [
  ['check_changes', 'Checks the files you changed, laid over the default branch: the same findings the pull-request check would report.'],
  ['list_rules', 'The rules in effect for a repository, in plain language, with who approved them.'],
  ['explain_finding', 'The rule text behind a finding, its approval, and how code usually satisfies it.'],
  ['request_exception', 'Asks Legal for a time-limited exception. It cannot approve anything.'],
  ['search_obligations', 'Finds approved obligations by meaning, e.g. "can we log phone numbers?"'],
];

type Client = 'kiro' | 'claude-code' | 'cursor' | 'vscode' | 'codex' | 'claude-desktop' | 'antigravity';
const CLIENTS: Array<{ id: Client; label: string }> = [
  { id: 'kiro', label: 'Kiro' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'antigravity', label: 'Antigravity' },
];

function snippet(client: Client, url: string, token: string | null): { label: string; code: string; note: string } {
  const literal = token ?? 'lexc_pat_…';
  switch (client) {
    case 'kiro':
      return {
        label: '.kiro/settings/mcp.json (this project) or ~/.kiro/settings/mcp.json',
        code: JSON.stringify({ mcpServers: { lexcompiler: { url, headers: { Authorization: 'Bearer ${LEXCOMPILER_TOKEN}' }, autoApprove: ['list_rules', 'check_changes', 'explain_finding', 'search_obligations'] } } }, null, 2),
        note: 'Kiro asks you once to allow ${LEXCOMPILER_TOKEN}. The tools appear in the MCP panel, and Kiro reads AGENTS.md.',
      };
    case 'claude-code':
      return { label: 'Terminal, in your project', code: `claude mcp add --transport http lexcompiler ${url} \\\n  --header "Authorization: Bearer $LEXCOMPILER_TOKEN"`, note: 'Check it with claude mcp list. Claude Code stores the token in ~/.claude.json.' };
    case 'cursor':
      return { label: '~/.cursor/mcp.json', code: JSON.stringify({ mcpServers: { lexcompiler: { url, headers: { Authorization: 'Bearer ${env:LEXCOMPILER_TOKEN}' } } } }, null, 2), note: "If Cursor doesn't expand ${env:…} in headers, put the token itself in this file (it's outside your repository)." };
    case 'vscode':
      return { label: '.mcp.json at the repository root', code: JSON.stringify({ mcpServers: { lexcompiler: { type: 'http', url, headers: { Authorization: 'Bearer ${LEXCOMPILER_TOKEN}' } } } }, null, 2), note: 'GitHub Copilot and Claude Code both read this file. It holds only the variable name, so it can be committed.' };
    case 'codex':
      return { label: '~/.codex/config.toml', code: `[mcp_servers.lexcompiler]\nurl = "${url}"\nbearer_token_env_var = "LEXCOMPILER_TOKEN"`, note: 'The Codex CLI, IDE extension and desktop app share this file. Type /mcp to see the server.' };
    case 'claude-desktop':
      return {
        label: 'claude_desktop_config.json (Settings → Developer → Edit Config)',
        code: JSON.stringify({ mcpServers: { lexcompiler: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: `Bearer ${literal}` } } } }, null, 2),
        note: 'Claude Desktop reaches HTTP servers through mcp-remote. Restart it after editing.',
      };
    case 'antigravity':
      return { label: '~/.gemini/antigravity/mcp_config.json', code: JSON.stringify({ mcpServers: { lexcompiler: { serverUrl: url, headers: { Authorization: `Bearer ${literal}` } } } }, null, 2), note: 'Antigravity uses serverUrl and has no variable substitution, so the token sits in this file.' };
  }
}

export function AssistantsPage() {
  const { workspace, me } = useSession();
  const toast = useToast();
  const tokens = useApi<TokenRecord[]>(`/workspaces/${workspace.id}/tokens`);
  const calls = useApi<AssistantCall[]>(`/workspaces/${workspace.id}/assistant-calls?limit=30`, { pollMs: 5000 });
  const [name, setName] = useState('Kiro on my laptop');
  const [days, setDays] = useState('30');
  const [fresh, setFresh] = useState<TokenRecord | null>(null);
  const [client, setClient] = useState<Client>('kiro');
  const [busy, setBusy] = useState(false);
  const url = `${window.location.origin}/mcp`;
  const create = async () => {
    setBusy(true);
    try {
      setFresh(await api<TokenRecord>(`/workspaces/${workspace.id}/tokens`, { body: { name, days: Number(days) } }));
      await tokens.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: TokenRecord) => {
    await api(`/workspaces/${workspace.id}/tokens/${t.id}/revoke`, { body: {} });
    toast(`"${t.name}" revoked. Assistants using it are disconnected.`);
    if (fresh?.id === t.id) setFresh(null);
    await tokens.reload();
  };
  const s = snippet(client, url, fresh?.token ?? null);
  return (
    <>
      <PageHeader title="Coding assistants" description="Connect Kiro, Claude Code, Cursor or any MCP client. Your assistant checks code against the rules Legal approved before you push, and gets the same answer as the pull-request check." />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card title="1. Create your access token" description={`Personal to you (${me.name ?? me.email}) and this workspace. It acts with your role, and expires.`}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Field label="Name" htmlFor="token-name">
                  <Input id="token-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </div>
              <Field label="Expires after" htmlFor="token-days">
                <Select id="token-days" value={days} onChange={(e) => setDays(e.target.value)} className="w-32">
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </Select>
              </Field>
              <Button variant="primary" icon={<KeyRound className="size-4" />} loading={busy} disabled={!name.trim()} onClick={create}>
                Create token
              </Button>
            </div>
            {fresh?.token && (
              <div className="mt-4">
                <Notice tone="green" icon={<KeyRound className="size-4" />}>
                  <div className="font-medium">Copy your token now. LexCompiler stores only a hash, so it can't show it again.</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Mono className="break-all rounded bg-white px-2 py-1 text-zinc-800 ring-1 ring-emerald-200">{fresh.token}</Mono>
                    <CopyButton text={fresh.token} />
                  </div>
                </Notice>
              </div>
            )}
          </Card>

          <Card title="2. Add LexCompiler to your assistant" description="Set the token as an environment variable, then add the server.">
            <div className="space-y-4">
              <CodeBlock label="Shell profile (~/.bashrc, ~/.zshrc)" code={`export LEXCOMPILER_TOKEN=${fresh?.token ?? 'lexc_pat_…'}`} />
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Assistant">
                {CLIENTS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={client === c.id}
                    onClick={() => setClient(c.id)}
                    className={cx('cursor-pointer rounded-lg px-2.5 py-1 text-sm font-medium', client === c.id ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <CodeBlock label={s.label} code={s.code} />
              <p className="text-sm text-zinc-500">{s.note}</p>
              <Notice tone="gray">
                Then ask your assistant: <em>“Check my changes with LexCompiler before I commit.”</em> Server: <Mono>{url}</Mono> (Streamable HTTP, MCP 2025-06-18).
              </Notice>
            </div>
          </Card>

          <Card title="Recent assistant activity" description="Calls from coding assistants in this workspace. File contents are never stored." padded={false}>
            {!calls.data?.length ? (
              <EmptyState icon={<Bot className="size-5" />} title="No calls yet" description="Once an assistant is connected, each tool call shows here." />
            ) : (
              <Table head={<><Th>Who</Th><Th>Tool</Th><Th>Result</Th><Th className="text-right">When</Th></>}>
                {calls.data.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <div className="text-zinc-900">{c.userName}</div>
                      <div className="text-xs text-zinc-500">{c.client ?? 'MCP client'}</div>
                    </Td>
                    <Td>
                      <Mono className="text-zinc-800">{c.tool}</Mono>
                      {c.repo && <div className="text-xs text-zinc-500">{c.repo}</div>}
                    </Td>
                    <Td className="text-zinc-600">
                      {c.outcome === 'ok' ? c.summary : <span className="text-rose-700">{c.summary}</span>}
                      <div className="text-xs text-zinc-500">{c.durationMs} ms</div>
                    </Td>
                    <Td className="whitespace-nowrap text-right text-xs text-zinc-500">{timeAgo(c.createdAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card title="Tools your assistant gets">
            <ul className="space-y-3">
              {TOOLS.map(([t, d]) => (
                <li key={t}>
                  <Mono className="font-semibold text-zinc-900">{t}</Mono>
                  <p className="mt-0.5 text-sm text-zinc-600">{d}</p>
                </li>
              ))}
            </ul>
            <p className="mt-4 flex gap-2 border-t border-zinc-100 pt-4 text-sm text-zinc-500">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" /> No tool can approve rules or exceptions, change rules, or see another workspace.
            </p>
          </Card>
          <Card title="Your tokens" padded={false}>
            {!tokens.data?.length ? (
              <EmptyState title="No tokens yet" />
            ) : (
              <ul className="divide-y divide-zinc-100">
                {tokens.data.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 px-5 py-3">
                    <KeyRound className="mt-0.5 size-4 text-zinc-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-900">{t.name}</span>
                        {t.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge tone="gray">{t.status}</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        …{t.hint} · {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}${t.lastClient ? ` by ${t.lastClient}` : ''}` : 'never used'} · expires {formatDate(t.expiresAt)}
                      </div>
                    </div>
                    {t.status === 'active' && (
                      <Button size="sm" variant="ghost" onClick={() => revoke(t)}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
