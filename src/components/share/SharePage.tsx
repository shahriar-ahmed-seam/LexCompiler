import { useEffect, useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { verifyHeadersInBrowser, type BrowserKey } from './verifyInBrowser';

/**
 * The auditor's page behind a share link, /share/<token> (product guide, Phase 5): summary, rule
 * history, checks over time, exceptions, the evidence pack, and a check in the browser. No
 * account is needed. Code is never shown.
 */

interface ShareData {
  workspace: { id: string; name: string };
  label: string | null;
  counterparty: string | null;
  period: { from: string; to: string };
  expiresAt: string;
  repos: string[];
  rules: Array<{
    key: string;
    title: string;
    versions: Array<{ version: number; status: string; text: string; citation: string; clauseSha256: string; approvedBy: string | null; approvedAt: string | null; effectiveFrom: string | null }>;
  }>;
  scans: Array<{
    id: string;
    at: string;
    repo: string;
    commit: string;
    pullRequest: number | null;
    conclusion: string | null;
    perRule: Array<{ ruleKey: string; newCount: number; existingCount: number; waivedCount: number }>;
    evidence: { seq: number; headerSha256: string } | null;
  }>;
  openFindings: Array<{ repo: string; ruleKey: string; filePath: string; startLine: number; state: string; message: string }>;
  exceptions: Array<{ id: string; ruleKey: string; repo: string | null; where: string | null; reason: string; status: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; expiresAt: string | null }>;
  evidence: {
    headers: Array<{ seq: number; header: string; headerSha256: string; signature: string }>;
    bodySeqs: number[];
    timestamps?: Array<{ seq: number; headerSha256: string; tsaUrl: string; genTime: string }>;
  };
  keysUrl: string;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16);
const th = 'text-left font-semibold text-zinc-300 border-b border-zinc-700 px-2 py-1';
const td = 'border-b border-zinc-800 px-2 py-1 align-top';

export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error((json && json.error) || `${res.status} ${res.statusText}`);
        setData(json as ShareData);
      })
      .catch((err: Error) => setError(err.message));
  }, [token]);

  const verify = async () => {
    if (!data) return;
    setChecking(true);
    try {
      const keys = (await (await fetch(data.keysUrl)).json()) as BrowserKey[];
      const problems = await verifyHeadersInBrowser(data.evidence.headers, keys);
      setCheck(
        problems.length
          ? { ok: false, text: problems.join('; ') }
          : { ok: true, text: `OK: ${data.evidence.headers.length} signed headers in an unbroken chain. For an independent check, run verify.mjs from the pack with keys from ${data.workspace.name}'s own website.` }
      );
    } catch (err) {
      setCheck({ ok: false, text: `This browser could not check the signatures: ${(err as Error).message}` });
    } finally {
      setChecking(false);
    }
  };

  if (error) {
    return (
      <main className="min-h-screen bg-[#050609] text-zinc-100 p-6">
        <p role="alert" className="rounded bg-rose-950 text-rose-200 px-3 py-2 text-sm max-w-xl">
          {error}
        </p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="min-h-screen bg-[#050609] text-zinc-100 p-6">
        <p role="status">Loading…</p>
      </main>
    );
  }
  const failing = data.scans.filter((s) => s.conclusion === 'failure').length;
  return (
    <main className="min-h-screen bg-[#050609] text-zinc-100 p-6 space-y-6 max-w-6xl">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-emerald-300" aria-hidden />
          Compliance evidence: {data.workspace.name}
        </h1>
        <p className="text-sm text-zinc-300">
          {data.counterparty ? `Shared with ${data.counterparty}. ` : ''}
          {data.label ? `${data.label}. ` : ''}Period {day(data.period.from)} to {day(data.period.to)}. This link works until {day(data.expiresAt)}.
        </p>
      </header>

      <section aria-labelledby="summary-heading" className="space-y-2">
        <h2 id="summary-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
          Summary
        </h2>
        <ul className="text-sm text-zinc-200 list-disc ml-5">
          <li>
            {data.rules.length} {data.rules.length === 1 ? 'rule' : 'rules'} ({data.rules.map((r) => r.key).join(', ')}) on {data.repos.join(', ') || 'no repositories'}.
          </li>
          <li>
            {data.scans.length} checks in the period, {failing} failed.
          </li>
          <li>{data.exceptions.length} exceptions.</li>
          <li>
            {data.evidence.headers.length} signed evidence records; {data.evidence.bodySeqs.length} are about this share.
          </li>
          {data.evidence.timestamps?.map((t) => (
            <li key={t.seq}>
              Record #{t.seq} timestamped by {new URL(t.tsaUrl).host} at {when(t.genTime)} UTC (RFC 3161; the token is in the pack).
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/share/${encodeURIComponent(token)}/pack.zip`} className="rounded bg-sky-700 hover:bg-sky-800 text-white px-3 py-1.5 text-sm inline-flex items-center gap-1">
            <Download className="w-4 h-4" aria-hidden /> Download the evidence pack
          </a>
          <button type="button" disabled={checking} onClick={() => void verify()} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-3 py-1.5 text-sm disabled:opacity-50">
            Verify signatures in this browser
          </button>
        </div>
        {check && (
          <p role="status" className={`rounded px-3 py-2 text-sm ${check.ok ? 'bg-emerald-950 text-emerald-200' : 'bg-rose-950 text-rose-200'}`}>
            {check.text}
          </p>
        )}
      </section>

      <section aria-labelledby="rules-heading" className="space-y-3">
        <h2 id="rules-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
          Rule history
        </h2>
        {data.rules.map((r) => (
          <article key={r.key} aria-label={`${r.key} history`} className="rounded border border-zinc-800 p-3 space-y-2">
            <h3 className="font-semibold">
              {r.key}: {r.title}
            </h3>
            {r.versions.map((v) => (
              <div key={v.version} className="text-sm space-y-1">
                <p className="text-zinc-300">
                  v{v.version} ({v.status}) · approved by {v.approvedBy ?? 'unknown'} on {day(v.approvedAt)} · in effect from {day(v.effectiveFrom ?? v.approvedAt)}
                </p>
                <blockquote className="border-l-2 border-zinc-600 pl-3 text-zinc-200">{v.text}</blockquote>
                <p className="text-xs text-zinc-400 break-all">
                  {v.citation} · clause SHA-256 {v.clauseSha256}
                </p>
              </div>
            ))}
          </article>
        ))}
      </section>

      <section aria-labelledby="checks-heading" className="space-y-2">
        <h2 id="checks-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
          Checks over time
        </h2>
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Repository</th>
                <th className={th}>Commit</th>
                <th className={th}>Pull request</th>
                <th className={th}>Result</th>
                <th className={th}>New / existing / waived</th>
                <th className={th}>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {data.scans.map((s) => (
                <tr key={s.id}>
                  <td className={td}>{when(s.at)}</td>
                  <td className={td}>{s.repo}</td>
                  <td className={`${td} font-mono text-xs`}>{s.commit.slice(0, 12)}</td>
                  <td className={td}>{s.pullRequest ?? '—'}</td>
                  <td className={td}>{s.conclusion}</td>
                  <td className={td}>
                    {s.perRule.map((p) => (
                      <div key={p.ruleKey}>
                        {p.ruleKey}: {p.newCount} / {p.existingCount} / {p.waivedCount}
                      </div>
                    ))}
                  </td>
                  <td className={`${td} font-mono text-xs`}>{s.evidence ? `#${s.evidence.seq} ${s.evidence.headerSha256.slice(0, 16)}…` : '—'}</td>
                </tr>
              ))}
              {data.scans.length === 0 && (
                <tr>
                  <td className={td} colSpan={7}>
                    No checks in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data.openFindings.length > 0 && (
          <>
            <h3 className="text-sm font-semibold text-zinc-300">Findings on the latest default-branch check (code is not shown)</h3>
            <ul className="text-sm text-zinc-200 space-y-1">
              {data.openFindings.map((f, i) => (
                <li key={i}>
                  {f.ruleKey} · {f.repo} <span className="font-mono text-xs">{f.filePath}:{f.startLine}</span> · {f.state}: {f.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="exceptions-heading" className="space-y-2">
        <h2 id="exceptions-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
          Exceptions
        </h2>
        {data.exceptions.length === 0 && <p className="text-sm text-zinc-400">None in this period.</p>}
        <ul className="space-y-2">
          {data.exceptions.map((e) => (
            <li key={e.id} className="rounded border border-zinc-800 p-2 text-sm">
              <p>
                <span className="font-semibold">{e.ruleKey}</span> {e.repo} <span className="font-mono text-xs">{e.where}</span>: {e.status}
                {e.expiresAt ? ` until ${day(e.expiresAt)}` : ''}
              </p>
              <p className="text-xs text-zinc-300">Reason: {e.reason}</p>
              {e.decidedBy && (
                <p className="text-xs text-zinc-300">
                  Decided by {e.decidedBy} on {day(e.decidedAt)}: {e.decisionNote}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
