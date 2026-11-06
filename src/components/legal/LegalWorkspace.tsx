import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { FileText, Scale, Upload } from 'lucide-react';
import { SharesPanel } from './SharesPanel';
import { ChangesPanel } from './ChangesPanel';
import { AgentCrewPanel } from './AgentCrewPanel';
import { EffectiveDateControl, RescopeControl } from './RuleControls';

/**
 * The lawyer's workspace (product guide, Phase 3): upload a contract or regulation, see its
 * clauses, turn a clause into a rule card, and approve it. Served at /legal.
 */

interface Workspace {
  id: string;
  name: string;
  role: string;
}
interface Counterparty {
  id: string;
  name: string;
}
interface DocSummary {
  id: string;
  title: string;
  kind: string;
  fileFormat: string;
  uploadedAt: string;
}
interface Clause {
  index: number;
  number: string | null;
  text: string;
  normative: boolean;
  normativeMatches: Array<{ start: number; end: number; text: string }>;
}
interface Highlight {
  start: number;
  end: number;
  text: string;
  kind: 'value' | 'keyword' | 'normative';
}
type ValueField = 'maxRetentionHours' | 'requiresTenantIsolatedKeys' | 'minAiConfidenceThreshold' | 'allowedDataRegions' | 'maxBreachNotificationHours';
interface CardValue {
  field: ValueField;
  label: string;
  value: number | boolean | string[] | null;
  source: 'parser' | 'model' | 'legal' | 'question';
  question: string | null;
}
interface ImpactRepo {
  repoId: string;
  repoName: string;
  failures: number | null;
  places: Array<{ filePath: string; line: number }>;
}
interface CardPreview {
  category: string;
  categoryLabel: string;
  categoryFromWording: boolean;
  plainReading: string;
  highlights: Highlight[];
  values: CardValue[];
  questions: Array<{ id: string; text: string; sets?: ValueField }>;
  ai: { model: string; checked: { status: string } } | null;
  aiNote: string | null;
  compiled: { smtLib2: string; rego: string };
  impact: ImpactRepo[];
}
interface RuleVersion {
  id: string;
  version: number;
  status: 'draft' | 'approved' | 'rejected' | 'retired';
  approvedBy: string | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  createdAt: string;
  scope?: { all?: boolean; counterpartyIds?: string[] };
}
interface Rule {
  id: string;
  key: string;
  title: string;
  versions: RuleVersion[];
}
interface ExceptionRequest {
  id: string;
  ruleKey: string;
  repoName: string | null;
  filePath: string | null;
  startLine: number | null;
  pathGlob: string | null;
  message: string | null;
  reason: string;
  requestedBy: string;
  requestedFrom: 'github' | 'dashboard' | 'assistant';
  requestedUntil?: string | null;
  prNumber: number | null;
}
interface Inbox {
  exceptionRequests: ExceptionRequest[];
  ruleDrafts: Array<{ versionId: string; ruleKey: string; version: number }>;
}

/** One exception request: Legal approves with a reason and an end date, or rejects. */
function ExceptionRequestCard({ request, busy, onDecide }: { request: ExceptionRequest; busy: boolean; onDecide: (approve: boolean, note: string, expiresAt: string) => void }) {
  const [note, setNote] = useState('');
  const [until, setUntil] = useState(request.requestedUntil ? request.requestedUntil.slice(0, 10) : '');
  const where = request.filePath ? `${request.filePath}:${request.startLine ?? 1}` : request.pathGlob ?? '';
  const by = request.requestedBy.startsWith('github:') ? `@${request.requestedBy.slice(7)} on GitHub` : request.requestedFrom === 'assistant' ? 'a coding assistant' : 'the dashboard';
  return (
    <li className="rounded border border-zinc-800 p-2 text-sm space-y-2" aria-label={`Exception request for ${request.ruleKey} at ${where}`}>
      <p>
        <span className="font-semibold">{request.ruleKey}</span> <span className="font-mono text-xs">{where}</span>
        {request.repoName && <span className="text-zinc-400"> in {request.repoName}</span>}
        {request.prNumber !== null && <span className="text-zinc-400"> (pull request #{request.prNumber})</span>}
      </p>
      {request.message && <p className="text-xs text-zinc-300">{request.message}</p>}
      <p className="text-xs text-zinc-400">
        Requested from {by}: {request.reason}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-zinc-300">
          Reason for the decision
          <input className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm w-72" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="text-xs text-zinc-300">
          Waived until
          <input type="date" className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !note.trim() || !until}
          onClick={() => onDecide(true, note, new Date(`${until}T23:59:59Z`).toISOString())}
          className="rounded bg-emerald-700 hover:bg-emerald-800 text-white px-2 py-1 disabled:opacity-50"
        >
          Approve exception
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide(false, note, '')} className="rounded bg-rose-700 hover:bg-rose-800 text-white px-2 py-1 disabled:opacity-50">
          Reject exception
        </button>
      </div>
    </li>
  );
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && typeof json.error === 'string' && json.error) || `${res.status} ${res.statusText}`);
  return json as T;
}

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const MARK: Record<Highlight['kind'], string> = {
  value: 'bg-amber-900 text-amber-100 rounded px-0.5',
  keyword: 'bg-sky-950 text-sky-200 rounded px-0.5',
  normative: 'underline decoration-emerald-400 decoration-2 underline-offset-2',
};

/** The clause text with the card's highlights as <mark> elements. */
export function HighlightedText({ text, highlights }: { text: string; highlights: Highlight[] }) {
  const parts: ReactElement[] = [];
  let at = 0;
  [...highlights]
    .sort((a, b) => a.start - b.start)
    .forEach((h, i) => {
      if (h.start < at) return;
      if (h.start > at) parts.push(<span key={`t${i}`}>{text.slice(at, h.start)}</span>);
      parts.push(
        <mark key={`m${i}`} className={MARK[h.kind]} data-kind={h.kind}>
          {text.slice(h.start, h.end)}
        </mark>
      );
      at = h.end;
    });
  if (at < text.length) parts.push(<span key="end">{text.slice(at)}</span>);
  return <>{parts}</>;
}

const SOURCE_LABEL: Record<CardValue['source'], string> = {
  parser: 'read by the parser',
  model: 'suggested by a model, confirmed by the parser',
  legal: 'set by you',
  question: 'needs your answer',
};

export function LegalWorkspace() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [categories, setCategories] = useState<Array<{ id: string; label: string }>>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [documents, setDocuments] = useState<DocSummary[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [inbox, setInbox] = useState<Inbox>({ exceptionRequests: [], ruleDrafts: [] });
  const [docId, setDocId] = useState<string | null>(null);
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [clause, setClause] = useState<Clause | null>(null);
  const [card, setCard] = useState<CardPreview | null>(null);
  const [category, setCategory] = useState<string>('');
  const [values, setValues] = useState<Partial<Record<ValueField, unknown>>>({});
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [citation, setCitation] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Upload form
  const [upTitle, setUpTitle] = useState('');
  const [upKind, setUpKind] = useState('contract');
  const [upCounterparty, setUpCounterparty] = useState('');
  const [upLanguage, setUpLanguage] = useState('en');
  const [upText, setUpText] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upUrl, setUpUrl] = useState('');
  const [browserbase, setBrowserbase] = useState(false);

  const ws = workspaces.find((w) => w.id === workspaceId);
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
      const [list, cats] = await Promise.all([api<Workspace[]>('/api/workspaces'), api<Array<{ id: string; label: string }>>('/api/rule-categories')]);
      setWorkspaces(list);
      setCategories(cats);
      if (list[0]) setWorkspaceId((id) => id || list[0].id);
    });
  }, [run]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const [docs, cps, rs, box] = await Promise.all([
      api<DocSummary[]>(`${base}/documents`),
      api<Counterparty[]>(`${base}/counterparties`),
      api<Rule[]>(`${base}/rules`),
      api<Inbox>(`${base}/inbox`),
    ]);
    setDocuments(docs);
    setCounterparties(cps);
    setRules(rs);
    setInbox(box);
    // Older servers have no such route; the URL import then stays hidden.
    setBrowserbase(Boolean((await api<{ browserbase?: boolean }>(`${base}/integrations`).catch(() => null))?.browserbase));
  }, [base, workspaceId]);
  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  const openDocument = (id: string) =>
    run(async () => {
      const doc = await api<{ clauses: Clause[] }>(`${base}/documents/${id}`);
      setDocId(id);
      setClauses(doc.clauses);
      setClause(null);
      setCard(null);
    });

  const upload = () =>
    run(async () => {
      const body: Record<string, unknown> = { title: upTitle || upFile?.name || 'Untitled document', kind: upKind, language: upLanguage, counterpartyId: upCounterparty || undefined };
      if (upFile) Object.assign(body, { fileName: upFile.name, contentBase64: await fileToBase64(upFile) });
      else body.text = upText;
      const doc = await api<{ id: string; clauses: Clause[] }>(`${base}/documents`, body);
      await refresh();
      setDocId(doc.id);
      setClauses(doc.clauses);
      setUpText('');
      setUpFile(null);
      setUpTitle('');
      setMessage({ kind: 'ok', text: `Uploaded. ${doc.clauses.filter((c) => c.normative).length} of ${doc.clauses.length} clauses are normative.` });
    });

  const importFromUrl = () =>
    run(async () => {
      const doc = await api<{ id: string; clauses: Clause[] }>(`${base}/documents/from-url`, { url: upUrl.trim(), title: upTitle || undefined, kind: upKind, language: upLanguage, counterpartyId: upCounterparty || undefined });
      await refresh();
      setDocId(doc.id);
      setClauses(doc.clauses);
      setClause(null);
      setCard(null);
      setUpUrl('');
      setMessage({ kind: 'ok', text: `Imported. ${doc.clauses.filter((c) => c.normative).length} of ${doc.clauses.length} clauses are normative.` });
    });

  const requestCard = useCallback(
    (c: Clause, next: { category?: string; values?: Partial<Record<ValueField, unknown>>; scopeIds?: string[] } = {}) =>
      run(async () => {
        const preview = await api<CardPreview>(`${base}/rule-card`, {
          text: c.text,
          normativeMatches: c.normativeMatches,
          category: (next.category ?? category) || undefined,
          values: next.values ?? values,
          scope: (next.scopeIds ?? scopeIds).length ? { counterpartyIds: next.scopeIds ?? scopeIds } : { all: true },
        });
        setCard(preview);
      }),
    [base, category, run, scopeIds, values]
  );

  const pickClause = (c: Clause) => {
    setClause(c);
    setCategory('');
    setValues({});
    setScopeIds([]);
    setAnswers({});
    setTitle('');
    setCitation(c.number ? `${documents.find((d) => d.id === docId)?.title ?? 'Document'} §${c.number}` : '');
    void requestCard(c, { category: '', values: {}, scopeIds: [] });
  };

  const setValue = (field: ValueField, raw: unknown) => {
    const next = { ...values, [field]: raw };
    setValues(next);
    if (clause) void requestCard(clause, { values: next });
  };

  const saveDraft = () =>
    run(async () => {
      if (!clause || !card) return;
      const r = await api<{ rule: Rule; version: RuleVersion }>(`${base}/rules`, {
        rawLegalText: clause.text,
        title: title || card.categoryLabel,
        citation: citation || undefined,
        category: category || card.category,
        values,
        scope: scopeIds.length ? { counterpartyIds: scopeIds } : { all: true },
        documentId: docId ?? undefined,
      });
      await refresh();
      setMessage({ kind: 'ok', text: `${r.rule.key} v${r.version.version} saved as a draft, waiting for approval.` });
    });

  const decide = (version: RuleVersion, action: 'approve' | 'reject') =>
    run(async () => {
      const body = action === 'approve' ? { effectiveFrom: effectiveFrom || undefined, answers } : { note: 'Rejected in the workspace' };
      const r = await api<RuleVersion & { queuedScans?: unknown[] }>(`${base}/rule-versions/${version.id}/${action}`, body);
      await refresh();
      const n = r.queuedScans?.length ?? 0;
      setMessage({ kind: 'ok', text: action === 'approve' ? `Approved. ${n === 1 ? '1 repository' : `${n} repositories`} queued for a scan of main.` : 'Rejected.' });
    });

  const moveEffective = (v: RuleVersion, date: string) =>
    run(async () => {
      const r = await api<{ inEffect: boolean; effectiveFrom: string }>(`${base}/rule-versions/${v.id}/effective`, { effectiveFrom: date });
      await refresh();
      setMessage({ kind: 'ok', text: r.inEffect ? 'In effect now. Default branches in scope are rescanned.' : `Moved to ${r.effectiveFrom.slice(0, 10)}.` });
    });
  const rescope = (rule: Rule, scope: { all: true } | { counterpartyIds: string[] }) =>
    run(async () => {
      const r = await api<{ version: { version: number } }>(`${base}/rules/${rule.id}/rescope`, scope);
      await refresh();
      setMessage({ kind: 'ok', text: `${rule.key} v${r.version.version} drafted with the new scope, waiting for approval.` });
    });
  const decideException = (request: ExceptionRequest, approve: boolean, note: string, expiresAt: string) =>
    run(async () => {
      const r = await api<{ rerunJobId: string | null }>(`${base}/exceptions/${request.id}/${approve ? 'approve' : 'reject'}`, approve ? { note, expiresAt } : { note });
      await refresh();
      setMessage({ kind: 'ok', text: `Exception ${approve ? 'approved' : 'rejected'}.${r.rerunJobId ? ' The pull request check runs again.' : ''}` });
    });

  const totalFailures = useMemo(() => card?.impact.reduce((n, r) => n + (r.failures ?? 0), 0) ?? 0, [card]);
  // Rules and exceptions are decided by Legal (server/product/store.ts PERMISSIONS).
  const canEdit = ws && ['legal', 'admin'].includes(ws.role);

  return (
    <div className="min-h-screen bg-[#050609] text-zinc-100 p-6">
      <header className="flex flex-wrap items-center gap-4 mb-6">
        <Scale className="w-6 h-6 text-amber-300" aria-hidden />
        <h1 className="text-xl font-semibold">Lawyer&apos;s workspace</h1>
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

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr_1.4fr]">
        <section aria-labelledby="docs-heading" className="space-y-4">
          <h2 id="docs-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
            Documents
          </h2>
          <ul className="space-y-1">
            {documents.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => void openDocument(d.id)} aria-pressed={d.id === docId} className={`w-full text-left rounded px-2 py-1 text-sm flex items-center gap-2 ${d.id === docId ? 'bg-[#0D131F] text-white' : 'text-zinc-300 hover:text-white'}`}>
                  <FileText className="w-4 h-4" aria-hidden />
                  {d.title} <span className="text-zinc-400">({d.fileFormat})</span>
                </button>
              </li>
            ))}
            {documents.length === 0 && <li className="text-sm text-zinc-400">No documents yet.</li>}
          </ul>
          {canEdit && (
            <form
              className="space-y-2 rounded border border-zinc-800 p-3"
              aria-label="Upload a document"
              onSubmit={(e) => {
                e.preventDefault();
                void upload();
              }}
            >
              <label className="block text-xs text-zinc-300">
                Title
                <input className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={upTitle} onChange={(e) => setUpTitle(e.target.value)} />
              </label>
              <label className="block text-xs text-zinc-300">
                Kind
                <select className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={upKind} onChange={(e) => setUpKind(e.target.value)}>
                  <option value="contract">Contract</option>
                  <option value="regulation">Regulation</option>
                  <option value="policy">Policy</option>
                </select>
              </label>
              <label className="block text-xs text-zinc-300">
                Counterparty
                <select className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={upCounterparty} onChange={(e) => setUpCounterparty(e.target.value)}>
                  <option value="">None</option>
                  {counterparties.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-zinc-300">
                Language
                <select className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={upLanguage} onChange={(e) => setUpLanguage(e.target.value)}>
                  <option value="en">English</option>
                  <option value="bn">Bangla</option>
                </select>
              </label>
              <label className="block text-xs text-zinc-300">
                File (PDF, Word or text, up to 3 MB)
                <input type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" className="mt-1 block w-full text-xs" onChange={(e) => setUpFile(e.target.files?.[0] ?? null)} />
              </label>
              <label className="block text-xs text-zinc-300">
                …or paste the text
                <textarea className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm h-24" value={upText} onChange={(e) => setUpText(e.target.value)} />
              </label>
              <button type="submit" disabled={busy || (!upFile && !upText.trim())} className="w-full rounded bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                <Upload className="w-4 h-4" aria-hidden /> Upload
              </button>
              {browserbase && (
                <div className="space-y-2 border-t border-zinc-800 pt-2">
                  <label className="block text-xs text-zinc-300">
                    …or import from a URL
                    <input type="url" placeholder="https://" className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={upUrl} onChange={(e) => setUpUrl(e.target.value)} />
                  </label>
                  <button type="button" disabled={busy || !upUrl.trim()} onClick={() => void importFromUrl()} className="w-full rounded bg-zinc-700 hover:bg-zinc-800 text-white px-3 py-1.5 text-sm disabled:opacity-50">
                    Import from URL
                  </button>
                </div>
              )}
            </form>
          )}
        </section>

        <section aria-labelledby="clauses-heading">
          <h2 id="clauses-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-2">
            Clauses
          </h2>
          {docId === null && <p className="text-sm text-zinc-400">Open a document to see its clauses.</p>}
          <ol className="space-y-2">
            {clauses.map((c) => (
              <li key={c.index}>
                <button
                  type="button"
                  onClick={() => pickClause(c)}
                  aria-pressed={clause?.index === c.index}
                  aria-label={`${c.number ? `Clause ${c.number}` : 'Preamble'}${c.normative ? '' : ' (not normative, skipped)'}`}
                  className={`w-full text-left rounded border p-2 text-sm ${clause?.index === c.index ? 'border-amber-300 bg-[#0D131F]' : 'border-zinc-800'} ${c.normative ? 'text-zinc-100' : 'text-zinc-400'}`}
                >
                  <span className="font-mono text-xs text-amber-300 mr-2">{c.number ?? '—'}</span>
                  {c.normative ? <span className="text-xs text-emerald-400 mr-2">normative</span> : <span className="text-xs text-zinc-400 mr-2">skipped</span>}
                  <span className="block mt-1 line-clamp-3" lang={/[ঀ-৿]/.test(c.text) ? 'bn' : undefined}>
                    {c.text}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="card-heading" className="space-y-4">
          <h2 id="card-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">
            Rule card
          </h2>
          {!card || !clause ? (
            <p className="text-sm text-zinc-400">Pick a clause to draft a rule from it.</p>
          ) : (
            <article aria-label="Rule card" className="rounded border border-zinc-800 bg-[#06090F] p-4 space-y-4">
              <blockquote className="text-sm leading-relaxed" lang={/[ঀ-৿]/.test(clause.text) ? 'bn' : undefined}>
                <HighlightedText text={clause.text} highlights={card.highlights} />
              </blockquote>
              <div className="flex flex-wrap gap-3 items-end">
                <label className="text-xs text-zinc-300">
                  Category
                  <select
                    className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm"
                    value={category || card.category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      void requestCard(clause, { category: e.target.value, values: {} });
                      setValues({});
                    }}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!card.categoryFromWording && <span className="text-xs text-amber-300">The wording names no category; check this one.</span>}
              </div>
              <p className="text-sm">
                <span className="text-zinc-400">Reads as: </span>
                {card.plainReading}
              </p>
              {card.ai && <p className="text-xs text-sky-300">Suggested by {card.ai.model} ({card.ai.checked.status === 'accepted' ? 'confirmed by the parser' : 'not confirmed, see the question'})</p>}
              {card.aiNote && <p className="text-xs text-amber-300">{card.aiNote}</p>}

              {card.values.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-semibold text-zinc-300">Values</legend>
                  {card.values.map((v) => (
                    <div key={v.field} className="text-sm">
                      <label className="flex flex-wrap items-center gap-2">
                        <span className="w-56">{v.label}</span>
                        {typeof v.value === 'boolean' || v.field === 'requiresTenantIsolatedKeys' ? (
                          <input type="checkbox" checked={Boolean(values[v.field] ?? v.value)} onChange={(e) => setValue(v.field, e.target.checked)} />
                        ) : v.field === 'allowedDataRegions' ? (
                          <input
                            className="bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 w-64"
                            placeholder="eu-central-1, eu-west-1"
                            defaultValue={Array.isArray(v.value) ? v.value.join(', ') : ''}
                            onBlur={(e) => setValue(v.field, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                          />
                        ) : (
                          <input
                            type="number"
                            step="any"
                            className="bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 w-32"
                            defaultValue={typeof v.value === 'number' ? v.value : ''}
                            key={`${v.field}-${String(v.value)}`}
                            onBlur={(e) => e.target.value && setValue(v.field, Number(e.target.value))}
                          />
                        )}
                        <span className={`text-xs ${v.source === 'question' ? 'text-amber-300' : 'text-zinc-400'}`}>{SOURCE_LABEL[v.source]}</span>
                      </label>
                      {v.question && <p className="text-xs text-amber-300 ml-56">{v.question}</p>}
                    </div>
                  ))}
                </fieldset>
              )}

              <fieldset className="space-y-1">
                <legend className="text-xs font-semibold text-zinc-300">Scope</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopeIds.length === 0}
                    onChange={() => {
                      setScopeIds([]);
                      void requestCard(clause, { scopeIds: [] });
                    }}
                  />
                  All repositories of the workspace
                </label>
                {counterparties.map((cp) => (
                  <label key={cp.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={scopeIds.includes(cp.id)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...scopeIds, cp.id] : scopeIds.filter((x) => x !== cp.id);
                        setScopeIds(next);
                        void requestCard(clause, { scopeIds: next });
                      }}
                    />
                    {cp.name}
                  </label>
                ))}
              </fieldset>

              {card.questions.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-semibold text-zinc-300">Questions</legend>
                  {card.questions.map((q) => (
                    <label key={q.id} className="block text-sm">
                      {q.text}
                      <input className="mt-1 w-full bg-[#0B101B] border border-zinc-700 rounded px-2 py-1" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                    </label>
                  ))}
                </fieldset>
              )}

              <div role="status" aria-label="Impact preview" className="text-sm rounded bg-[#0D131F] p-3">
                <p className="font-semibold">{totalFailures === 1 ? '1 place would fail' : `${totalFailures} places would fail`}</p>
                <ul className="mt-1 text-xs text-zinc-300 space-y-0.5">
                  {card.impact.map((r) => (
                    <li key={r.repoId}>
                      {r.repoName}: {r.failures === null ? 'not scanned yet' : `${r.failures} (${r.places.map((p) => `${p.filePath}:${p.line}`).join(', ') || 'none'})`}
                    </li>
                  ))}
                  {card.impact.length === 0 && <li>No repositories in scope.</li>}
                </ul>
              </div>

              <details>
                <summary className="text-xs text-zinc-300 cursor-pointer">SMT-LIB2 and Rego</summary>
                <pre className="mt-2 text-xs whitespace-pre-wrap text-zinc-300">{card.compiled.smtLib2}</pre>
                <pre className="mt-2 text-xs whitespace-pre-wrap text-zinc-300">{card.compiled.rego}</pre>
              </details>

              {canEdit && (
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="text-xs text-zinc-300">
                    Rule title
                    <input className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={title} placeholder={card.categoryLabel} onChange={(e) => setTitle(e.target.value)} />
                  </label>
                  <label className="text-xs text-zinc-300">
                    Citation
                    <input className="mt-1 block bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={citation} onChange={(e) => setCitation(e.target.value)} />
                  </label>
                  <button type="button" disabled={busy} onClick={() => void saveDraft()} className="rounded bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
                    Save as draft
                  </button>
                </div>
              )}
            </article>
          )}

          <section aria-labelledby="inbox-heading">
            <h2 id="inbox-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-2">
              Legal inbox ({inbox.exceptionRequests.length + inbox.ruleDrafts.length})
            </h2>
            {inbox.exceptionRequests.length + inbox.ruleDrafts.length === 0 && <p className="text-sm text-zinc-400">Nothing waits for Legal.</p>}
            {inbox.ruleDrafts.length > 0 && <p className="text-sm text-zinc-300 mb-2">Rules waiting for approval: {inbox.ruleDrafts.map((d) => `${d.ruleKey} v${d.version}`).join(', ')} (below).</p>}
            <ul className="space-y-2">
              {inbox.exceptionRequests.map((e) =>
                canEdit ? (
                  <ExceptionRequestCard key={e.id} request={e} busy={busy} onDecide={(approve, note, expiresAt) => void decideException(e, approve, note, expiresAt)} />
                ) : (
                  <li key={e.id} className="text-sm text-zinc-300">
                    {e.ruleKey} {e.filePath ?? e.pathGlob}: waiting for Legal
                  </li>
                )
              )}
            </ul>
          </section>

          <section aria-labelledby="rules-heading">
            <h2 id="rules-heading" className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-2">
              Rules
            </h2>
            {canEdit && (
              <label className="text-xs text-zinc-300 block mb-2">
                Effective from (empty: when approved)
                <input type="date" className="ml-2 bg-[#0B101B] border border-zinc-700 rounded px-2 py-1 text-sm" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
              </label>
            )}
            <ul className="space-y-2">
              {rules.map((r) => (
                <li key={r.id} className="rounded border border-zinc-800 p-2 text-sm">
                  <p className="font-semibold">
                    {r.key} {r.title}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {r.versions.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <span>v{v.version}</span>
                        <span className={v.status === 'approved' ? 'text-emerald-400' : v.status === 'draft' ? 'text-amber-300' : 'text-zinc-400'}>
                          {v.status === 'draft' ? 'waiting for approval' : v.status}
                        </span>
                        {v.approvedAt && <span className="text-zinc-400">{new Date(v.approvedAt).toLocaleString()}</span>}
                        {v.status === 'approved' && v.effectiveFrom && v.effectiveFrom > new Date().toISOString() && (
                          canEdit ? (
                            <EffectiveDateControl ruleKey={r.key} version={v.version} effectiveFrom={v.effectiveFrom} busy={busy} onMove={(date) => void moveEffective(v, date)} />
                          ) : (
                            <span className="text-amber-300">takes effect {v.effectiveFrom.slice(0, 10)}</span>
                          )
                        )}
                        {v.scope?.counterpartyIds?.length ? (
                          <span className="text-zinc-400">for {v.scope.counterpartyIds.map((id) => counterparties.find((c) => c.id === id)?.name ?? id).join(', ')}</span>
                        ) : null}
                        {v.status === 'draft' && canEdit && (
                          <>
                            <button type="button" disabled={busy} onClick={() => void decide(v, 'approve')} className="rounded bg-emerald-700 hover:bg-emerald-800 text-white px-2 py-0.5">
                              Approve {r.key} v{v.version}
                            </button>
                            <button type="button" disabled={busy} onClick={() => void decide(v, 'reject')} className="rounded bg-rose-700 hover:bg-rose-800 text-white px-2 py-0.5">
                              Reject {r.key} v{v.version}
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  {canEdit && r.versions.some((v) => v.status === 'approved') && (
                    <div className="mt-1">
                      <RescopeControl ruleKey={r.key} counterparties={counterparties} busy={busy} onRescope={(scope) => void rescope(r, scope)} />
                    </div>
                  )}
                </li>
              ))}
              {rules.length === 0 && <li className="text-sm text-zinc-400">No rules yet.</li>}
            </ul>
          </section>

          {ws && ['owner', 'legal', 'admin'].includes(ws.role) && <SharesPanel key={workspaceId} base={base} rules={rules} counterparties={counterparties} />}

          {workspaceId && (
            <ChangesPanel
              key={`changes-${workspaceId}`}
              base={base}
              canEdit={Boolean(canEdit)}
              onOpenDocument={openDocument}
              canOpenFixes={Boolean(ws && ['owner', 'legal', 'engineer', 'admin'].includes(ws.role))}
              onChanged={refresh}
            />
          )}

          {workspaceId && <AgentCrewPanel key={`crew-${workspaceId}`} base={base} canRun={Boolean(ws && ['owner', 'legal', 'engineer', 'admin'].includes(ws.role))} />}
        </section>
      </div>
    </div>
  );
}
