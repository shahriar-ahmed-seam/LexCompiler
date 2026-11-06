import { useCallback, useEffect, useState } from 'react';

/**
 * "Share with an auditor" (product guide, Phase 5): Legal picks the counterparty, rules, period
 * and expiry, gets a /share/<token> link, sees who opened it, and can revoke it.
 */

interface Share {
  id: string;
  label: string | null;
  counterpartyName: string | null;
  ruleIds: string[];
  periodFrom: string;
  periodTo: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
}
interface View {
  at: string;
  ip: string | null;
  userAgent: string | null;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && typeof json.error === 'string' && json.error) || `${res.status} ${res.statusText}`);
  return json as T;
}

const day = (iso: string) => iso.slice(0, 10);
const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

export function SharesPanel({
  base,
  rules,
  counterparties,
}: {
  base: string;
  rules: Array<{ id: string; key: string; title: string; versions: Array<{ status: string }> }>;
  counterparties: Array<{ id: string; name: string }>;
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [label, setLabel] = useState('');
  const [counterpartyId, setCounterpartyId] = useState('');
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [days, setDays] = useState('7');
  const [link, setLink] = useState<string | null>(null);
  const [views, setViews] = useState<{ shareId: string; list: View[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const approved = rules.filter((r) => r.versions.some((v) => v.status === 'approved'));
  const keyOf = new Map(rules.map((r) => [r.id, r.key]));

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
  const refresh = useCallback(async () => setShares(await api<Share[]>(`${base}/shares`)), [base]);
  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  const create = () =>
    run(async () => {
      const r = await api<{ url: string }>(`${base}/shares`, {
        label: label || null,
        counterpartyId: counterpartyId || null,
        ruleIds,
        periodFrom: `${from}T00:00:00.000Z`,
        periodTo: `${to}T23:59:59.999Z`,
        expiresAt: new Date(Date.now() + Number(days) * 24 * 3600 * 1000).toISOString(),
      });
      setLink(r.url);
      await refresh();
    });
  const revoke = (s: Share) =>
    run(async () => {
      await api(`${base}/shares/${s.id}/revoke`, {});
      await refresh();
      setMessage({ kind: 'ok', text: 'Link revoked. It no longer opens.' });
    });
  const showViews = (s: Share) => run(async () => setViews({ shareId: s.id, list: await api<View[]>(`${base}/shares/${s.id}/views`) }));

  return (
    <section aria-labelledby="shares-heading" className="space-y-3">
      <h2 id="shares-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
        Share with an auditor
      </h2>
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`rounded px-3 py-2 text-sm ${message.kind === 'error' ? 'bg-rose-950 text-rose-200' : 'bg-emerald-950 text-emerald-200'}`}>
          {message.text}
        </p>
      )}
      <form
        className="space-y-2 text-xs text-zinc-300"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <fieldset className="space-y-1">
          <legend>Rules to share</legend>
          {approved.length === 0 && <p className="text-zinc-400">No approved rules yet.</p>}
          {approved.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ruleIds.includes(r.id)} onChange={(e) => setRuleIds((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id)))} />
              {r.key} {r.title}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <label>
            Counterparty
            <select className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)}>
              <option value="">All repositories</option>
              {counterparties.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Label
            <input className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm w-48" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Q4 audit" />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <label>
            Period from
            <input type="date" className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Period to
            <input type="date" className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            Link expires after
            <select className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy || ruleIds.length === 0 || !from || !to} className="rounded bg-sky-700 hover:bg-sky-800 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          Create share link
        </button>
      </form>
      {link && (
        <div className="rounded border border-amber-700 bg-amber-950/40 p-2 space-y-1">
          <p className="text-sm text-amber-100">Send this link to the auditor. It is shown once.</p>
          <input readOnly aria-label="Share link" className="w-full font-mono text-xs bg-[#0B101B] border border-zinc-700 rounded px-2 py-1" value={link} />
        </div>
      )}
      <ul className="space-y-2">
        {shares.map((s) => {
          const status = s.revokedAt ? 'revoked' : s.expiresAt <= new Date().toISOString() ? 'expired' : `open until ${day(s.expiresAt)}`;
          const name = s.label ?? s.counterpartyName ?? 'All repositories';
          return (
            <li key={s.id} aria-label={`Share ${name}`} className="rounded border border-zinc-800 p-2 text-sm space-y-1">
              <p>
                <span className="font-semibold">{name}</span> <span className="text-xs text-zinc-400">{s.ruleIds.map((id) => keyOf.get(id) ?? id).join(', ')}</span>
              </p>
              <p className="text-xs text-zinc-400">
                {day(s.periodFrom)} to {day(s.periodTo)} · {status} · {s.views === 1 ? '1 view' : `${s.views} views`}
              </p>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void showViews(s)} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-0.5 text-xs">
                  Views of {name}
                </button>
                {!s.revokedAt && (
                  <button type="button" disabled={busy} onClick={() => void revoke(s)} className="rounded bg-rose-700 hover:bg-rose-800 text-white px-2 py-0.5 text-xs">
                    Revoke {name}
                  </button>
                )}
              </div>
              {views?.shareId === s.id && (
                <ul aria-label={`Views of ${name}`} className="text-xs text-zinc-300">
                  {views.list.length === 0 && <li>Not opened yet.</li>}
                  {views.list.map((v, i) => (
                    <li key={i}>
                      {v.at.replace('T', ' ').slice(0, 19)} · {v.ip ?? 'unknown address'} · {v.userAgent ?? 'unknown browser'}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
