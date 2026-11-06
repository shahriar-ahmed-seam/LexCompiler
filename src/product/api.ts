import { useCallback, useEffect, useRef, useState } from 'react';

/** JSON calls to the LexCompiler API with the session cookie and the client header. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path.startsWith('/api') || path.startsWith('/.well-known') ? path : `/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-LexCompiler-Client': 'web' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

/** Loads `path` (null to skip), optionally polling. Keeps the last data while reloading. */
export function useApi<T>(path: string | null, options: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    try {
      const d = await api<T>(path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(Boolean(path));
    void reload();
    if (!path || !options.pollMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, options.pollMs);
    return () => clearInterval(t);
  }, [path, options.pollMs, reload]);
  return { data, error, loading, reload, setData };
}

// ---------------------------------------------------------------- routing

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

// ---------------------------------------------------------------- formatting

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${formatSpan(-s)}`;
  if (s < 45) return 'just now';
  return `${formatSpan(s)} ago`;
}

function formatSpan(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} d`;
  return `${Math.round(s / (86400 * 30))} mo`;
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatHours(h: number | null | undefined): string {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  const n = Number.isInteger(h) ? h : Math.round(h * 100) / 100;
  return `${n} hour${n === 1 ? '' : 's'}`;
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');
export const githubRepoUrl = (fullName: string) => `https://github.com/${fullName}`;
