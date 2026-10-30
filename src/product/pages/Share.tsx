import React, { useEffect, useState } from 'react';
import { CheckCircle2, FileCheck2, GitPullRequest, Inbox, Scale, XCircle } from 'lucide-react';
import { api, formatDate, timeAgo } from '../api';
import { Badge, Card, EmptyState, ErrorNote, Mono, RuleKey, Spinner, Table, Td, Th } from '../ui';
import type { PublicKey } from '../types';
import { VerifyPanel } from './Evidence';

interface ShareData {
  share: { label: string; periodFrom: string; periodTo: string; expiresAt: string; createdAt: string; createdBy: string | null };
  workspace: { id: string; name: string };
  generatedAt: string;
  rules: Array<{ key: string; title: string; retiredAt: string | null; versions: Array<{ version: number; status: string; category: string; requires: string; sourceText: string; clauseSha256: string; decidedBy: string | null; decidedAt: string | null; effectiveFrom: string | null }> }>;
  exceptions: Array<{ rule: string | null; repo: string | null; location: string | null; pr: number | null; reason: string; requestedBy: string | null; requestedAt: string; status: string; decidedBy: string | null; decidedAt: string | null; note: string | null; expiresAt: string | null }>;
  keys: PublicKey[];
  keysUrl: string;
  records: Array<{ seq: number; headerJson: string; headerSha256: string; signature: string; bodyJson: string; kind: string; text: string }>;
  verification: { ok: boolean; count: number; problems: string[] };
}

export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<PublicKey[] | null>(null);
  useEffect(() => {
    document.title = 'Shared compliance evidence · LexCompiler';
    api<ShareData>(`/api/public/share/${encodeURIComponent(token)}`)
      .then(async (d) => {
        setData(d);
        // Check against the keys published at the workspace's well-known URL, not the ones inside the page data.
        setKeys(await api<PublicKey[]>(d.keysUrl).catch(() => d.keys));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);
  if (error) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }
  if (!data || !keys) return <Spinner label="Loading the shared evidence" />;
  const scans = data.records
    .filter((r) => r.kind === 'check-failed' || r.kind === 'check-passed' || r.kind === 'scan')
    .map((r) => ({ ...r, body: JSON.parse(r.bodyJson) as { repo: string; pr: number | null; commit: string; conclusion: string; counts?: { new: number; existing: number; waived: number }; rules: Array<{ rule: string; version: number }> }, at: JSON.parse(r.headerJson).at as string }));
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <Scale className="size-4" aria-hidden />
            </span>
            <span className="font-semibold tracking-tight">LexCompiler</span>
            <span className="text-zinc-500">/</span>
            <span className="text-sm text-zinc-600">Shared evidence</span>
          </div>
          <span className="text-xs text-zinc-500">Read-only · link expires {formatDate(data.share.expiresAt)}</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <div className="text-sm text-zinc-500">{data.workspace.name}</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">{data.share.label}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Records from {formatDate(data.share.periodFrom)} to {formatDate(data.share.periodTo)} · shared by {data.share.createdBy ?? 'the workspace'} on {formatDate(data.share.createdAt)}
          </p>
        </div>

        <Card>
          <VerifyPanel records={data.records} keys={keys} server={data.verification} />
          <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
            The public key comes from <Mono>{data.keysUrl}</Mono>. For an independent check, compare it with the key the company publishes on its own website.
          </p>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <div className="flex items-center gap-2 text-sm text-zinc-500"><Scale className="size-4" /> Rules</div>
            <div className="mt-1 text-2xl font-semibold">{data.rules.length}</div>
          </Card>
          <Card>
            <div className="flex items-center gap-2 text-sm text-zinc-500"><GitPullRequest className="size-4" /> Checks in the period</div>
            <div className="mt-1 text-2xl font-semibold">{scans.length}</div>
          </Card>
          <Card>
            <div className="flex items-center gap-2 text-sm text-zinc-500"><Inbox className="size-4" /> Exceptions</div>
            <div className="mt-1 text-2xl font-semibold">{data.exceptions.length}</div>
          </Card>
        </div>

        <Card title="Rules and who approved them" padded={false}>
          {data.rules.length === 0 ? (
            <EmptyState title="No rules" />
          ) : (
            <ul className="divide-y divide-zinc-100">
              {data.rules.map((r) => (
                <li key={r.key} className="px-5 py-4">
                  <div className="flex items-center gap-2">
                    <RuleKey>{r.key}</RuleKey>
                    <span className="font-medium text-zinc-900">{r.title}</span>
                    {r.retiredAt && <Badge>Retired {formatDate(r.retiredAt)}</Badge>}
                  </div>
                  {r.versions.map((v) => (
                    <div key={v.version} className="mt-3 grid gap-3 rounded-lg border border-zinc-100 bg-zinc-50/50 p-3 md:grid-cols-2">
                      <div className="text-sm">
                        <div className="text-xs text-zinc-500">
                          v{v.version} · {v.status === 'approved' ? `approved by ${v.decidedBy ?? 'Legal'} on ${formatDate(v.decidedAt, true)}` : v.status}
                        </div>
                        <p className="mt-1 text-zinc-800">{v.requires}</p>
                      </div>
                      <blockquote className="border-l-2 border-zinc-200 pl-3 text-xs leading-relaxed text-zinc-600">{v.sourceText}</blockquote>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Checks" description="Each check records the commit, the exact rule versions, and the result." padded={false}>
          {scans.length === 0 ? (
            <EmptyState title="No checks in this period" />
          ) : (
            <Table head={<><Th>Result</Th><Th>Target</Th><Th>Findings</Th><Th>Rules</Th><Th className="text-right">When</Th></>}>
              {[...scans].reverse().map((s) => (
                <tr key={s.seq}>
                  <Td>{s.body.conclusion === 'failure' ? <span className="flex items-center gap-1.5 text-rose-700"><XCircle className="size-4" /> Failed</span> : <span className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="size-4" /> {s.body.pr ? 'Passed' : 'Reported'}</span>}</Td>
                  <Td>
                    <div className="text-zinc-900">{s.body.pr ? `Pull request #${s.body.pr}` : 'Default branch'}</div>
                    <div className="text-xs text-zinc-500">
                      {s.body.repo} · <Mono>{s.body.commit.slice(0, 7)}</Mono>
                    </div>
                  </Td>
                  <Td className="text-zinc-600">{s.body.counts ? `${s.body.counts.new} new · ${s.body.counts.existing} existing · ${s.body.counts.waived} waived` : '—'}</Td>
                  <Td className="text-xs text-zinc-500">{s.body.rules.map((r) => `${r.rule} v${r.version}`).join(', ')}</Td>
                  <Td className="whitespace-nowrap text-right text-xs text-zinc-500">{formatDate(s.at, true)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Exceptions" description="Findings Legal accepted for a limited time, with the reason." padded={false}>
          {data.exceptions.length === 0 ? (
            <EmptyState title="No exceptions" />
          ) : (
            <ul className="divide-y divide-zinc-100">
              {data.exceptions.map((e, i) => (
                <li key={i} className="px-5 py-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    {e.rule && <RuleKey>{e.rule}</RuleKey>}
                    <Mono className="text-zinc-800">{e.location}</Mono>
                    <Badge tone={e.status === 'approved' ? 'blue' : e.status === 'requested' ? 'amber' : 'gray'}>{e.status}</Badge>
                  </div>
                  <p className="mt-1.5 text-zinc-700">“{e.reason}”</p>
                  <div className="mt-1 text-xs text-zinc-500">
                    Requested by {e.requestedBy} {timeAgo(e.requestedAt)}
                    {e.decidedBy && ` · decided by ${e.decidedBy} on ${formatDate(e.decidedAt)}`}
                    {e.expiresAt && ` · until ${formatDate(e.expiresAt)}`}
                    {e.note && ` · “${e.note}”`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`All signed records (${data.records.length})`} padded={false}>
          <Table head={<><Th>#</Th><Th>What happened</Th><Th>Header SHA-256</Th></>}>
            {[...data.records].reverse().map((r) => (
              <tr key={r.seq}>
                <Td className="font-mono text-xs text-zinc-500">{r.seq}</Td>
                <Td className="text-zinc-800">{r.text}</Td>
                <Td>
                  <Mono className="text-xs text-zinc-500">{r.headerSha256.slice(0, 16)}…</Mono>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <p className="flex items-center justify-center gap-2 pb-8 text-xs text-zinc-500">
          <FileCheck2 className="size-3.5" /> Generated {formatDate(data.generatedAt, true)} by LexCompiler. Every view of this page is logged for the workspace.
        </p>
      </main>
    </div>
  );
}
