import { useMemo, useState } from 'react';
import { BookOpen, ChevronRight, Copy, Check, Search } from 'lucide-react';
import { API_SECTIONS, type ApiAccess, type ApiBlock, type ApiEndpoint, type ApiMethod, type ApiPage } from '../apiDocs';

/**
 * Modelflare-style API reference for the /lab shell: grouped nav on the left, the active
 * page in the middle, an "on this page" anchor list on the right, and a client-side
 * endpoint search. Content lives in ../apiDocs.ts — the page renders, the data is the doc.
 */

const METHOD_STYLE: Record<ApiMethod, string> = {
  GET: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  POST: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  PUT: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  PATCH: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  DELETE: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

const ACCESS_STYLE: Record<ApiAccess, { label: string; className: string }> = {
  'signed-in': { label: 'signed-in', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  view: { label: 'view', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  editRules: { label: 'editRules · legal', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  runScans: { label: 'runScans', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  manageWorkspace: { label: 'manageWorkspace · owner', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  decideExceptions: { label: 'decideExceptions · legal', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  requestExceptions: { label: 'requestExceptions', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  createShares: { label: 'createShares · owner/legal', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  bearer: { label: 'session or bearer', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  public: { label: 'public', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  'github-hmac': { label: 'GitHub-signed', className: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  oauth: { label: 'OAuth', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  'mcp-token': { label: 'MCP token', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
};

const endpointAnchor = (pageId: string, e: ApiEndpoint) => `${pageId}-${e.method}-${e.path}`;

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="rounded-xl bg-[#070B14] border border-slate-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800/80">
        <span className="text-[10.5px] font-mono text-slate-400">{label ?? 'shell'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy the example"
          className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <pre className="text-[11.5px] leading-relaxed font-mono text-slate-300 px-3 py-2.5 overflow-x-auto whitespace-pre">{code}</pre>
    </div>
  );
}

function Block({ block }: { block: ApiBlock }) {
  if (block.kind === 'p') return <p className="text-[13px] leading-relaxed text-slate-300">{block.text}</p>;
  if (block.kind === 'code') return <CodeBlock code={block.code} label={block.label} />;
  if (block.kind === 'list')
    return (
      <ul className="list-disc pl-5 space-y-1 text-[13px] text-slate-300">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="bg-[#0B101B] text-slate-200">
            {block.headers.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.join('|')} className="border-t border-slate-800/80 text-slate-300">
              {row.map((cell, i) => (
                <td key={i} className="px-3 py-2 font-mono text-[11.5px]">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointCard({ pageId, endpoint }: { pageId: string; endpoint: ApiEndpoint }) {
  const access = ACCESS_STYLE[endpoint.access];
  return (
    <article
      id={endpointAnchor(pageId, endpoint)}
      aria-label={`${endpoint.method} ${endpoint.path}`}
      className="rounded-xl bg-[#0B101B] border border-slate-800 p-3.5 space-y-2.5 scroll-mt-4"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded-md text-[10.5px] font-bold font-mono border ${METHOD_STYLE[endpoint.method]}`}>
          {endpoint.method}
        </span>
        <code className="text-[12.5px] font-mono text-slate-100 break-all">{endpoint.path}</code>
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${access.className}`}>{access.label}</span>
      </p>
      <p className="text-[12.5px] leading-relaxed text-slate-300">{endpoint.summary}</p>
      {endpoint.params && endpoint.params.length > 0 && (
        <table className="w-full text-left text-[11.5px]">
          <thead>
            <tr className="text-slate-400">
              <th className="py-1 pr-3 font-semibold">Param</th>
              <th className="py-1 pr-3 font-semibold">In</th>
              <th className="py-1 pr-3 font-semibold">Type</th>
              <th className="py-1 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody>
            {endpoint.params.map((p) => (
              <tr key={p.name} className="border-t border-slate-800/70">
                <td className="py-1.5 pr-3 font-mono text-slate-200">
                  {p.name}
                  {p.required && <span className="text-rose-300"> *</span>}
                </td>
                <td className="py-1.5 pr-3 text-slate-400">{p.in}</td>
                <td className="py-1.5 pr-3 font-mono text-slate-300">{p.type}</td>
                <td className="py-1.5 text-slate-300">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {endpoint.example && <CodeBlock code={endpoint.example} label="curl" />}
    </article>
  );
}

function PageBody({ page }: { page: ApiPage }) {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-100">{page.title}</h1>
      {page.intro && <p className="text-[13px] leading-relaxed text-slate-300">{page.intro}</p>}
      {page.blocks?.map((block, i) => <Block key={i} block={block} />)}
      {page.endpoints && page.endpoints.length > 0 && (
        <div className="space-y-3 pt-1">
          {page.endpoints.map((e) => (
            <EndpointCard key={`${e.method} ${e.path}`} pageId={page.id} endpoint={e} />
          ))}
        </div>
      )}
    </div>
  );
}

const allPages = API_SECTIONS.flatMap((s) => s.pages.map((p) => ({ section: s, page: p })));
const totalEndpoints = API_SECTIONS.reduce((n, s) => n + s.pages.reduce((m, p) => m + (p.endpoints?.length ?? 0), 0), 0);

export function ApiDocsView() {
  const [activePageId, setActivePageId] = useState('introduction');
  const [query, setQuery] = useState('');
  const active = allPages.find((x) => x.page.id === activePageId) ?? allPages[0];

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allPages.flatMap(({ section, page }) =>
      (page.endpoints ?? [])
        .filter((e) => `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(q))
        .map((e) => ({ section, page, endpoint: e }))
    );
  }, [query]);

  return (
    <div className="flex gap-5 items-start" aria-label="API reference">
      {/* Docs nav — sections and their pages */}
      <nav aria-label="API docs sections" className="w-52 shrink-0 space-y-4 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto pr-1">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search endpoints…"
            aria-label="Search endpoints"
            className="w-full rounded-lg bg-[#0B101B] border border-slate-800 pl-8 pr-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-sky-500/60"
          />
        </div>
        {query ? (
          <p className="text-[11px] font-mono text-slate-400 px-1">
            {hits.length} endpoint{hits.length === 1 ? '' : 's'} match{hits.length === 1 ? 'es' : ''}
          </p>
        ) : (
          API_SECTIONS.map((section) => (
            <div key={section.id} className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-1">{section.title}</p>
              {section.pages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => setActivePageId(page.id)}
                  aria-current={page.id === active.page.id ? 'page' : undefined}
                  className={`w-full text-left px-2 py-1 rounded-md text-[12px] cursor-pointer transition-colors ${
                    page.id === active.page.id
                      ? 'bg-sky-500/15 text-sky-200 border border-sky-500/30'
                      : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 border border-transparent'
                  }`}
                >
                  {page.title}
                </button>
              ))}
            </div>
          ))
        )}
        <p className="text-[10px] font-mono text-slate-400 px-1 pt-1 border-t border-slate-800/80">
          {totalEndpoints} endpoints · {allPages.length} pages
        </p>
      </nav>

      {/* Content — search results or the active page */}
      <main className="flex-1 min-w-0 rounded-2xl bg-[#080D17] border border-slate-800 p-5">
        {query ? (
          <div className="space-y-3">
            <h1 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <Search className="w-4 h-4 text-sky-400" /> Endpoint search
            </h1>
            {hits.length === 0 && <p className="text-[13px] text-slate-400">Nothing matches "{query}".</p>}
            {hits.map(({ section, page, endpoint }) => (
              <div key={`${endpoint.method} ${endpoint.path}`} className="space-y-1">
                <p className="text-[10.5px] font-mono text-slate-400">
                  {section.title} ·{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setActivePageId(page.id);
                      setQuery('');
                    }}
                    className="text-sky-300 underline cursor-pointer"
                  >
                    {page.title}
                  </button>
                </p>
                <EndpointCard pageId={page.id} endpoint={endpoint} />
              </div>
            ))}
          </div>
        ) : (
          <PageBody page={active.page} />
        )}
      </main>

      {/* On this page */}
      {!query && (
        <aside aria-label="On this page" className="w-44 shrink-0 sticky top-4 space-y-1.5 hidden xl:block">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1">
            <BookOpen className="w-3 h-3" /> On this page
          </p>
          {(active.page.endpoints ?? []).map((e) => (
            <a
              key={`${e.method} ${e.path}`}
              href={`#${endpointAnchor(active.page.id, e)}`}
              className="flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-sky-300 transition-colors truncate"
            >
              <ChevronRight className="w-3 h-3 shrink-0 text-slate-400" />
              <span className="truncate">
                {e.method} {e.path.replace('/api/workspaces/:workspaceId', '…')}
              </span>
            </a>
          ))}
          {(!active.page.endpoints || active.page.endpoints.length === 0) && (
            <p className="text-[11px] text-slate-400">Prose page — no endpoints.</p>
          )}
        </aside>
      )}
    </div>
  );
}
