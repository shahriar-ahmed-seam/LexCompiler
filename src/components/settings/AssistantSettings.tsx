import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';

/**
 * Settings → "Connect a coding assistant" (product guide, Phase 4a): personal access tokens for
 * the workspace MCP endpoint, and a ready configuration for each client in guide section 5.9.
 * Served at /settings.
 */

interface Workspace {
  id: string;
  name: string;
  role: string;
}
interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && typeof json.error === 'string' && json.error) || `${res.status} ${res.statusText}`);
  return json as T;
}

export interface ClientConfig {
  client: string;
  file: string;
  text: string;
  /** The configuration holds the token itself, not a variable name. */
  holdsToken: boolean;
}

/**
 * One configuration per client. Clients that expand variables in headers get `LEXCOMPILER_TOKEN`;
 * the others (Claude Desktop's bridge, Antigravity) need the token in the file.
 */
export function clientConfigs(url: string, token: string): ClientConfig[] {
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  const env = 'Bearer ${LEXCOMPILER_TOKEN}';
  return [
    {
      client: 'Kiro',
      file: '.kiro/settings/mcp.json',
      holdsToken: false,
      text: json({ mcpServers: { lexcompiler: { url, headers: { Authorization: env }, autoApprove: ['list_rules', 'check_changes', 'explain_finding', 'search_obligations'] } } }),
    },
    { client: 'VS Code with Copilot', file: '.mcp.json (repository root)', holdsToken: false, text: json({ mcpServers: { lexcompiler: { type: 'http', url, headers: { Authorization: env } } } }) },
    { client: 'Claude Code', file: '.mcp.json (repository root)', holdsToken: false, text: json({ mcpServers: { lexcompiler: { type: 'http', url, headers: { Authorization: env } } } }) },
    {
      client: 'Claude Desktop',
      file: 'claude_desktop_config.json',
      holdsToken: true,
      text: json({ mcpServers: { lexcompiler: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: `Bearer ${token}` } } } }),
    },
    { client: 'Cursor', file: '.cursor/mcp.json', holdsToken: false, text: json({ mcpServers: { lexcompiler: { url, headers: { Authorization: 'Bearer ${env:LEXCOMPILER_TOKEN}' } } } }) },
    { client: 'Codex', file: '~/.codex/config.toml', holdsToken: false, text: `[mcp_servers.lexcompiler]\nurl = "${url}"\nbearer_token_env_var = "LEXCOMPILER_TOKEN"\n` },
    { client: 'Antigravity', file: '~/.gemini/antigravity/mcp_config.json', holdsToken: true, text: json({ mcpServers: { lexcompiler: { serverUrl: url, headers: { Authorization: `Bearer ${token}` } } } }) },
  ];
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function AssistantSettings() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [mcpUrl, setMcpUrl] = useState('');
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [client, setClient] = useState('Claude Code');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const base = `/api/workspaces/${workspaceId}`;

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      const list = await api<Workspace[]>('/api/workspaces');
      setWorkspaces(list);
      if (list[0]) setWorkspaceId((id) => id || list[0].id);
    });
  }, [run]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const r = await api<{ mcpUrl: string; tokens: ApiToken[] }>(`${base}/tokens`);
    setTokens(r.tokens);
    setMcpUrl(r.mcpUrl);
  }, [base, workspaceId]);
  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  const create = () =>
    run(async () => {
      const r = await api<{ token: string; name: string }>(`${base}/tokens`, { name, days: Number(days) });
      setCreated({ token: r.token, name: r.name });
      setName('');
      await refresh();
    });
  const revoke = (t: ApiToken) =>
    run(async () => {
      await api(`${base}/tokens/${t.id}/revoke`, {});
      await refresh();
      setMessage({ kind: 'ok', text: `Revoked "${t.name}". Assistants using it now get 401.` });
    });
  const copy = (text: string, what: string) =>
    run(async () => {
      await navigator.clipboard.writeText(text);
      setMessage({ kind: 'ok', text: `Copied the ${what}.` });
    });

  const configs = created ? clientConfigs(mcpUrl, created.token) : [];
  const shown = configs.find((c) => c.client === client) ?? configs[0];

  return (
    <div className="min-h-screen bg-[#050609] text-zinc-100 p-6">
      <header className="flex flex-wrap items-center gap-4 mb-6">
        <KeyRound className="w-6 h-6 text-amber-300" aria-hidden />
        <h1 className="text-xl font-semibold">Connect a coding assistant</h1>
        <label className="text-sm text-zinc-300 flex items-center gap-2">
          Workspace
          <select aria-label="Workspace" className="bg-[#0B101B] border border-zinc-700 rounded px-2 py-1" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.role})
              </option>
            ))}
          </select>
        </label>
        <a className="text-sm text-sky-300 underline ml-auto" href="/lab">
          Back to the demo dashboard
        </a>
      </header>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mb-4 rounded px-3 py-2 text-sm ${message.kind === 'error' ? 'bg-rose-950 text-rose-200' : 'bg-emerald-950 text-emerald-200'}`}>
          {message.text}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2 max-w-6xl">
        <section aria-labelledby="tokens-heading" className="space-y-4">
          <h2 id="tokens-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
            Your tokens
          </h2>
          <p className="text-sm text-zinc-300">
            A token acts as you, with your role, in this workspace only. Assistants send it to <span className="font-mono">{mcpUrl || '/mcp'}</span>. LexCompiler stores only its hash.
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="text-xs text-zinc-300">
              Token name
              <input className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop, Claude Code" />
            </label>
            <label className="text-xs text-zinc-300">
              Expires after
              <select className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </select>
            </label>
            <button type="submit" disabled={busy || !name.trim() || !workspaceId} className="rounded bg-sky-700 hover:bg-sky-800 text-white px-3 py-1.5 text-sm disabled:opacity-50">
              Create token
            </button>
          </form>
          <ul className="space-y-2">
            {tokens.length === 0 && <li className="text-sm text-zinc-400">No tokens yet.</li>}
            {tokens.map((t) => {
              const status = t.revokedAt ? 'revoked' : new Date(t.expiresAt) <= new Date() ? 'expired' : 'active';
              return (
                <li key={t.id} aria-label={`Token ${t.name}`} className="rounded border border-zinc-800 p-2 text-sm flex flex-wrap items-center gap-3">
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-xs text-zinc-400">
                    {status === 'active' ? `expires ${day(t.expiresAt)}` : status} · {t.lastUsedAt ? `last used ${day(t.lastUsedAt)}` : 'never used'}
                  </span>
                  {status === 'active' && (
                    <button type="button" disabled={busy} onClick={() => void revoke(t)} className="ml-auto rounded bg-rose-700 hover:bg-rose-800 text-white px-2 py-1 text-xs disabled:opacity-50">
                      Revoke {t.name}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {created && shown && (
          <section aria-labelledby="config-heading" className="space-y-3">
            <h2 id="config-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
              Configuration
            </h2>
            <div className="rounded border border-amber-700 bg-amber-950/40 p-2 space-y-2">
              <p className="text-sm text-amber-100">Copy the token for &quot;{created.name}&quot; now. It is shown once.</p>
              <div className="flex gap-2">
                <input readOnly aria-label="New token" className="flex-1 font-mono text-xs bg-[#0B101B] border border-zinc-700 rounded px-2 py-1" value={created.token} />
                <button type="button" onClick={() => void copy(created.token, 'token')} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-1 text-xs inline-flex items-center gap-1">
                  <Copy className="w-3 h-3" aria-hidden /> Copy token
                </button>
              </div>
              <p className="text-xs text-zinc-300">Set it as LEXCOMPILER_TOKEN in your shell profile or a secrets manager, never in a committed file.</p>
            </div>
            <label className="text-xs text-zinc-300 block">
              Assistant
              <select className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={shown.client} onChange={(e) => setClient(e.target.value)}>
                {configs.map((c) => (
                  <option key={c.client} value={c.client}>
                    {c.client}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-zinc-300">
              <span className="font-mono">{shown.file}</span>
              {shown.holdsToken ? ': this file holds the token, so keep it private (outside every repository).' : ': the file names the variable, so it can be committed.'}
            </p>
            <pre aria-label={`${shown.client} configuration`} className="rounded bg-[#0B101B] border border-zinc-800 p-3 text-xs overflow-x-auto">
              {shown.text}
            </pre>
            <button type="button" onClick={() => void copy(shown.text, `${shown.client} configuration`)} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-1 text-xs inline-flex items-center gap-1">
              <Copy className="w-3 h-3" aria-hidden /> Copy configuration
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
