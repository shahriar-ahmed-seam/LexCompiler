import { useCallback, useEffect, useState } from 'react';

/**
 * Contract and regulation changes (product guide, Phase 6): what approved future versions will
 * find ("Coming up"), the regulation feed with "Draft rule change", and the paths that handle
 * each counterparty's data.
 */

interface ComingUpResult {
  repoName: string;
  versionId: string;
  ruleKey: string;
  version: number;
  effectiveFrom: string;
  commitSha: string;
  computedAt: string;
  findings: Array<{ filePath: string; startLine: number; message: string }>;
}
interface FeedItem {
  id: string;
  source: 'EUR_LEX' | 'FEDERAL_REGISTER';
  documentNumber: string;
  title: string;
  publicationDate: string | null;
  excerpt: string;
  url: string | null;
  kind: 'TEXT' | 'CHANGE_NOTICE';
  illustrative: boolean;
  documentId?: string | null;
  /** Regulation watch: the rules the item may affect, and a summary when the workspace's AI is on. */
  watch?: { affectedRuleKeys: string[]; summary: string | null; model: string | null } | null;
}
interface Repo {
  id: string;
  fullName: string;
  source?: 'github' | 'local';
}
interface Counterparty {
  id: string;
  name: string;
  scope?: Array<{ repoId: string; pathGlob: string }>;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && typeof json.error === 'string' && json.error) || `${res.status} ${res.statusText}`);
  return json as T;
}

const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** One counterparty's paths, one "repository: glob" pair per line. */
function ScopeEditor({ cp, repos, busy, onSave }: { cp: Counterparty; repos: Repo[]; busy: boolean; onSave: (scope: Array<{ repoId: string; pathGlob: string }>) => void }) {
  const nameOf = new Map(repos.map((r) => [r.id, r.fullName]));
  const [text, setText] = useState((cp.scope ?? []).map((s) => `${nameOf.get(s.repoId) ?? s.repoId}: ${s.pathGlob}`).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const byName = new Map(repos.map((r) => [r.fullName, r.id]));
    const scope: Array<{ repoId: string; pathGlob: string }> = [];
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const at = line.lastIndexOf(':');
      const repoId = at > 0 ? byName.get(line.slice(0, at).trim()) : undefined;
      if (!repoId) return setError(`"${line}": write "repository: path glob", with a repository of this workspace.`);
      scope.push({ repoId, pathGlob: line.slice(at + 1).trim() || '**' });
    }
    setError(null);
    onSave(scope);
  };
  return (
    <li className="rounded border border-zinc-800 p-2 text-sm space-y-1">
      <label className="block text-xs text-zinc-300">
        Paths that handle {cp.name}&apos;s data
        <textarea rows={3} className="mt-1 block w-full font-mono text-xs bg-[#0B101B] border border-zinc-700 rounded px-2 py-1" value={text} onChange={(e) => setText(e.target.value)} placeholder={`${repos[0]?.fullName ?? 'acme/core-platform'}: workers/**`} />
      </label>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <button type="button" disabled={busy} onClick={save} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-0.5 text-xs disabled:opacity-50">
        Save paths for {cp.name}
      </button>
    </li>
  );
}

export function ChangesPanel({ base, canEdit, canOpenFixes = false, onChanged }: { base: string; canEdit: boolean; canOpenFixes?: boolean; onChanged: () => Promise<void> }) {
  const [fixPr, setFixPr] = useState<{ repo: string; prNumber: number; url: string; created: boolean } | null>(null);
  const [comingUp, setComingUp] = useState<ComingUpResult[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

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
  const refresh = useCallback(async () => {
    const [c, f, r, cps] = await Promise.all([
      api<{ results: ComingUpResult[] }>(`${base}/coming-up`),
      api<FeedItem[]>(`${base}/feed`),
      api<Repo[]>(`${base}/repos`),
      api<Counterparty[]>(`${base}/counterparties`),
    ]);
    setComingUp(c.results);
    setFeed(f);
    setRepos(r);
    setCounterparties(cps);
  }, [base]);
  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  const draft = (item: FeedItem) =>
    run(async () => {
      const r = await api<{ rule: { key: string }; version: { version: number } }>(`${base}/feed/${encodeURIComponent(item.id)}/draft`, {});
      await refresh();
      await onChanged();
      setMessage({ kind: 'ok', text: `${r.rule.key} v${r.version.version} drafted from ${item.documentNumber}. Nothing takes effect until it is approved.` });
    });
  /** One verified commit fixing the default branch; LexCompiler refuses a fix Z3 doesn't prove. */
  const openFix = (repo: Repo) =>
    run(async () => {
      const r = await api<{ created: boolean; prNumber: number; url: string; files: string[] }>(`${base}/repos/${repo.id}/fix-pr`, {});
      setFixPr({ repo: repo.fullName, prNumber: r.prNumber, url: r.url, created: r.created });
    });
  const watchFeed = () =>
    run(async () => {
      const r = await api<{ noted: number; summarized: number; refused?: string; errors: string[] }>(`${base}/feed/watch`, {});
      await refresh();
      const why = r.refused === 'ai_off' ? ' AI is off for this workspace, so no summaries were written.' : r.refused === 'budget' ? " Today's AI budget is used up." : r.refused === 'no_model' ? ' No model is configured on this server.' : '';
      setMessage({ kind: r.errors.length ? 'error' : 'ok', text: `Regulation watch checked ${r.noted} new item${r.noted === 1 ? '' : 's'} and summarized ${r.summarized}.${why}${r.errors.length ? ` ${r.errors.join('; ')}` : ''}` });
    });
  const saveScope = (cp: Counterparty, scope: Array<{ repoId: string; pathGlob: string }>) =>
    run(async () => {
      await api(`${base}/counterparties/${cp.id}/scope`, { scope });
      await refresh();
      setMessage({ kind: 'ok', text: `Saved ${cp.name}'s paths. Rules scoped to ${cp.name} are checked only there from the next scan.` });
    });

  // Group "Coming up" by version.
  const versions = [...new Map(comingUp.map((c) => [c.versionId, c])).values()];

  return (
    <section aria-labelledby="changes-heading" className="space-y-4">
      <h2 id="changes-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
        Changes
      </h2>
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`rounded px-3 py-2 text-sm ${message.kind === 'error' ? 'bg-rose-950 text-rose-200' : 'bg-emerald-950 text-emerald-200'}`}>
          {message.text}
        </p>
      )}

      <div aria-labelledby="coming-up-heading" role="region" className="space-y-2">
        <h3 id="coming-up-heading" className="text-sm font-semibold">
          Coming up
        </h3>
        {versions.length === 0 && <p className="text-sm text-zinc-400">No approved version takes effect later.</p>}
        {versions.map((v) => {
          const rows = comingUp.filter((c) => c.versionId === v.versionId);
          const n = rows.reduce((k, r) => k + r.findings.length, 0);
          return (
            <article key={v.versionId} aria-label={`${v.ruleKey} v${v.version} coming up`} className="rounded border border-amber-800 p-2 text-sm space-y-1">
              <p>
                <span className="font-semibold">
                  {v.ruleKey} v{v.version}
                </span>{' '}
                takes effect on {longDate(v.effectiveFrom)}. {n === 0 ? 'Nothing on the default branches fails it.' : `${n === 1 ? '1 place fails' : `${n} places fail`} it today:`}
              </p>
              <ul className="text-xs text-zinc-300">
                {rows.flatMap((r) =>
                  r.findings.map((f, i) => (
                    <li key={`${r.repoName}-${i}`}>
                      {r.repoName} <span className="font-mono">{f.filePath}:{f.startLine}</span>: {f.message}
                    </li>
                  ))
                )}
              </ul>
            </article>
          );
        })}
      </div>

      {canOpenFixes && repos.some((r) => r.source === 'github') && (
        <div aria-labelledby="fixes-heading" role="region" className="space-y-2">
          <h3 id="fixes-heading" className="text-sm font-semibold">
            Fix the default branch
          </h3>
          <p className="text-xs text-zinc-400">One commit with every fix, opened as a pull request only when Z3 proves each rule after the patch.</p>
          <ul className="space-y-1">
            {repos
              .filter((r) => r.source === 'github')
              .map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-sm">
                  <span>{r.fullName}</span>
                  <button type="button" disabled={busy} onClick={() => void openFix(r)} className="rounded bg-emerald-700 hover:bg-emerald-800 text-white px-2 py-0.5 text-xs disabled:opacity-50">
                    Open fix PR for {r.fullName}
                  </button>
                </li>
              ))}
          </ul>
          {fixPr && (
            <p role="status" className="text-sm text-emerald-200">
              {fixPr.created ? 'Opened' : 'Already open for this commit:'}{' '}
              <a className="underline" href={fixPr.url} target="_blank" rel="noreferrer">
                pull request #{fixPr.prNumber}
              </a>{' '}
              on {fixPr.repo}.
            </p>
          )}
        </div>
      )}

      <div aria-labelledby="feed-heading" role="region" className="space-y-2">
        <h3 id="feed-heading" className="text-sm font-semibold">
          Regulation feed
        </h3>
        {canEdit && feed.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void watchFeed()} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-0.5 text-xs disabled:opacity-50">
            Run regulation watch
          </button>
        )}
        {feed.length === 0 && <p className="text-sm text-zinc-400">No items yet. The feed is fetched once a day.</p>}
        <ul className="space-y-2">
          {feed.slice(0, 20).map((item) => (
            <li key={item.id} aria-label={`Feed item ${item.documentNumber}`} className="rounded border border-zinc-800 p-2 text-sm space-y-1">
              <p>
                <span className="text-xs text-zinc-400">{item.source === 'EUR_LEX' ? 'EUR-Lex' : 'Federal Register'} · {item.publicationDate ?? 'undated'} · </span>
                {item.url ? (
                  <a className="text-sky-300 underline" href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
                {item.illustrative && <span className="text-xs text-amber-300"> (illustrative text)</span>}
              </p>
              <p className="text-xs text-zinc-300 line-clamp-3">{item.excerpt}</p>
              {item.watch && (item.watch.summary || item.watch.affectedRuleKeys.length > 0) && (
                <p className="text-xs text-sky-200">
                  {item.watch.summary && <span>Regulation watch: {item.watch.summary} </span>}
                  {item.watch.affectedRuleKeys.length > 0 && <span className="font-semibold">May affect {item.watch.affectedRuleKeys.join(', ')}.</span>}
                </p>
              )}
              {item.kind === 'CHANGE_NOTICE' ? (
                <p className="text-xs text-zinc-400">Change notice: open the amended act and upload its new text.</p>
              ) : item.documentId ? (
                <p className="text-xs text-emerald-400">Drafted as a rule.</p>
              ) : (
                canEdit && (
                  <button type="button" disabled={busy} onClick={() => void draft(item)} className="rounded bg-sky-700 hover:bg-sky-800 text-white px-2 py-0.5 text-xs disabled:opacity-50">
                    Draft rule change from {item.documentNumber}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      </div>

      {canEdit && counterparties.length > 0 && (
        <div aria-labelledby="scope-heading" role="region" className="space-y-2">
          <h3 id="scope-heading" className="text-sm font-semibold">
            Where each counterparty&apos;s data is handled
          </h3>
          <p className="text-xs text-zinc-400">Rules scoped to a counterparty are proven only on these paths. Shared code in both scopes must meet the stricter rule.</p>
          <ul className="space-y-2">
            {counterparties.map((cp) => (
              <ScopeEditor key={`${cp.id}-${cp.scope?.length ?? 0}`} cp={cp} repos={repos} busy={busy} onSave={(scope) => void saveScope(cp, scope)} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
