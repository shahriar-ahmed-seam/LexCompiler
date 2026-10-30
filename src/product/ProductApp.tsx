import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { FileCheck2, GitPullRequest, Inbox, LayoutDashboard, Loader2, LogOut, Scale, Settings, SquareTerminal, FlaskConical } from 'lucide-react';
import { api, navigate, useApi, usePath } from './api';
import { Avatar, Badge, cx, EmptyState, Link, ToastProvider } from './ui';
import { ROLE_LABEL, type ExceptionRecord, type Me, type Role } from './types';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { NewRulePage, RuleDetailPage, RulesPage } from './pages/Rules';
import { CheckDetailPage, ChecksPage } from './pages/Checks';
import { ExceptionsPage } from './pages/Exceptions';
import { EvidencePage } from './pages/Evidence';
import { AssistantsPage } from './pages/Assistants';
import { SettingsPage } from './pages/Settings';
import { SharePage } from './pages/Share';

interface Session {
  me: Me;
  workspace: { id: string; name: string; role: Role };
  setWorkspace: (id: string) => void;
}
const SessionContext = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('no session');
  return s;
}

export function ProductApp() {
  useEffect(() => {
    document.documentElement.classList.add('lexc-product');
    document.documentElement.classList.remove('dark');
    document.body.className = 'antialiased';
  }, []);
  const path = usePath();
  return <ToastProvider>{path.startsWith('/share/') ? <SharePage token={decodeURIComponent(path.slice(7).split(/[?#]/)[0])} /> : <SessionGate path={path} />}</ToastProvider>;
}

function SessionGate({ path }: { path: string }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      setMe(await api<Me | null>('/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem('lexc.workspace'));

  if (me === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center text-zinc-500">
        <Loader2 className="size-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (path.startsWith('/login')) return <LoginPage me={me} onSignedIn={load} />;
  if (!me) {
    queueMicrotask(() => navigate(`/login?returnTo=${encodeURIComponent(path)}`, true));
    return null;
  }
  if (path === '/' || path === '') queueMicrotask(() => navigate('/app', true));
  const ws = me.workspaces.find((w) => w.id === chosen) ?? me.workspaces[0];
  if (!ws) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <EmptyState title="You're not in a workspace yet" description="Ask a workspace owner to invite your email address, then sign in again." />
      </div>
    );
  }
  const session: Session = {
    me,
    workspace: { id: ws.id, name: ws.name, role: ws.role },
    setWorkspace: (id) => {
      localStorage.setItem('lexc.workspace', id);
      setChosen(id);
      navigate('/app');
    },
  };
  return (
    <SessionContext.Provider value={session}>
      <Shell path={path}>
        <Route path={path} />
      </Shell>
    </SessionContext.Provider>
  );
}

function Route({ path }: { path: string }) {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/app';
  const seg = p.split('/').filter(Boolean);
  if (p === '/app') return <OverviewPage />;
  if (seg[1] === 'rules' && seg[2] === 'new') return <NewRulePage />;
  if (seg[1] === 'rules' && seg[2]) return <RuleDetailPage ruleId={seg[2]} />;
  if (seg[1] === 'rules') return <RulesPage />;
  if (seg[1] === 'checks' && seg[2]) return <CheckDetailPage scanId={seg[2]} />;
  if (seg[1] === 'checks') return <ChecksPage />;
  if (seg[1] === 'exceptions') return <ExceptionsPage />;
  if (seg[1] === 'evidence') return <EvidencePage />;
  if (seg[1] === 'assistants') return <AssistantsPage />;
  if (seg[1] === 'settings') return <SettingsPage />;
  return <EmptyState title="Page not found" description="This page doesn't exist." action={<Link to="/app" className="text-sm font-medium text-indigo-600">Back to the overview</Link>} />;
}

function Shell({ path, children }: { path: string; children: React.ReactNode }) {
  const { me, workspace, setWorkspace } = useSession();
  const waiting = useApi<ExceptionRecord[]>(`/workspaces/${workspace.id}/exceptions?status=requested`, { pollMs: 8000 });
  const nav = [
    { to: '/app', label: 'Overview', icon: LayoutDashboard, exact: true },
    { to: '/app/rules', label: 'Rules', icon: Scale },
    { to: '/app/checks', label: 'Checks', icon: GitPullRequest },
    { to: '/app/exceptions', label: 'Exceptions', icon: Inbox, count: waiting.data?.length || 0 },
    { to: '/app/evidence', label: 'Evidence', icon: FileCheck2 },
    { to: '/app/assistants', label: 'Coding assistants', icon: SquareTerminal },
    { to: '/app/settings', label: 'Settings', icon: Settings },
  ];
  const current = path.split(/[?#]/)[0];
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    window.location.assign('/login');
  };
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-zinc-200 bg-white">
        <div className="flex h-14 items-center gap-2.5 border-b border-zinc-100 px-4">
          <span className="flex size-7 items-center justify-center rounded-lg bg-zinc-900 text-white">
            <Scale className="size-4" aria-hidden />
          </span>
          <span className="font-semibold tracking-tight text-zinc-900">LexCompiler</span>
        </div>
        <div className="px-3 pt-3">
          <div className="rounded-lg border border-zinc-200 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-zinc-900">{workspace.name}</span>
              <Badge tone="indigo">Pilot</Badge>
            </div>
            {me.workspaces.length > 1 ? (
              <select aria-label="Switch workspace" className="mt-1 w-full cursor-pointer bg-transparent text-xs text-zinc-500 outline-none" value={workspace.id} onChange={(e) => setWorkspace(e.target.value)}>
                {me.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="mt-0.5 text-xs text-zinc-500">{ROLE_LABEL[workspace.role]}</div>
            )}
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3 py-3" aria-label="Main">
          {nav.map((n) => {
            const active = n.exact ? current === n.to : current.startsWith(n.to);
            return (
              <Link key={n.to} to={n.to} className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium', active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900')}>
                <n.icon className={cx('size-4', active ? 'text-indigo-600' : 'text-zinc-500')} aria-hidden />
                <span className="flex-1">{n.label}</span>
                {n.count ? <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-800">{n.count}</span> : null}
              </Link>
            );
          })}
          <div className="pt-4">
            <a href="/lab" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900">
              <FlaskConical className="size-4 text-zinc-400" aria-hidden /> Engine console
            </a>
          </div>
        </nav>
        <div className="flex items-center gap-2.5 border-t border-zinc-100 px-4 py-3">
          <Avatar name={me.name ?? me.email} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-zinc-900">{me.name ?? me.email ?? 'Signed in'}</div>
            <div className="truncate text-xs text-zinc-500">{ROLE_LABEL[workspace.role]}</div>
          </div>
          {me.via !== 'loopback' && me.via !== 'api-token' && (
            <button type="button" onClick={signOut} title="Sign out" aria-label="Sign out" className="cursor-pointer rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700">
              <LogOut className="size-4" />
            </button>
          )}
        </div>
      </aside>
      <main className="pl-60">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
