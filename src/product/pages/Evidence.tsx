import React, { useState } from 'react';
import { Download, ExternalLink, FileCheck2, Link2, ShieldCheck, ShieldX } from 'lucide-react';
import { api, formatDate, timeAgo, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Badge, Button, Card, CodeBlock, CopyButton, EmptyState, ErrorNote, Field, Input, Modal, Mono, Notice, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '../ui';
import { can, type EvidenceRecord, type PublicKey, type ShareRecord } from '../types';
import { verifyInBrowser, type BrowserCheck } from '../verify';

const TYPE_TONE: Record<string, 'indigo' | 'red' | 'green' | 'amber' | 'blue' | 'gray'> = {
  'rule.approved': 'indigo',
  'rule.rejected': 'gray',
  'rule.retired': 'gray',
  'scan.completed': 'gray',
  'exception.requested': 'amber',
  'exception.approved': 'green',
  'exception.rejected': 'red',
  'exception.expired': 'gray',
  'exception.revoked': 'gray',
  'share.created': 'blue',
  'share.revoked': 'gray',
};

export function VerifyPanel({ records, keys, server }: { records: Array<{ headerJson: string; signature: string; bodyJson?: string }>; keys: PublicKey[]; server?: { ok: boolean; count: number; problems: string[] } | null }) {
  const [result, setResult] = useState<BrowserCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await verifyInBrowser(records, keys));
    } finally {
      setBusy(false);
    }
  };
  const ok = result ? result.ok : server?.ok;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className={ok === false ? 'rounded-full bg-rose-100 p-2.5 text-rose-700' : 'rounded-full bg-emerald-100 p-2.5 text-emerald-700'}>{ok === false ? <ShieldX className="size-5" /> : <ShieldCheck className="size-5" />}</div>
      <div className="min-w-0 flex-1">
        {result ? (
          result.ok ? (
            <>
              <div className="font-medium text-zinc-900">Verified in your browser: {result.count} signatures, unbroken chain</div>
              <div className="text-sm text-zinc-500">Ed25519 signatures and SHA-256 links checked with Web Crypto in {result.ms} ms, by code running on your side.</div>
            </>
          ) : (
            <>
              <div className="font-medium text-rose-700">{result.supported ? `${result.problems.length} problem(s) found` : 'Not supported in this browser'}</div>
              <div className="text-sm text-rose-700">{result.problems.slice(0, 3).join(' · ')}</div>
            </>
          )
        ) : server ? (
          <>
            <div className="font-medium text-zinc-900">{server.ok ? `${server.count} records · signatures valid · chain unbroken` : `${server.problems.length} problem(s) in the log`}</div>
            <div className="text-sm text-zinc-500">Checked by the server. Check it yourself with the public key:</div>
          </>
        ) : (
          <div className="font-medium text-zinc-900">{records.length} signed records</div>
        )}
        {keys[0] && <Mono className="text-xs text-zinc-500">{keys[0].keyId}</Mono>}
      </div>
      <Button variant="primary" loading={busy} onClick={run} icon={<ShieldCheck className="size-4" />}>
        Verify in this browser
      </Button>
    </div>
  );
}

export function EvidencePage() {
  const { workspace } = useSession();
  const toast = useToast();
  const log = useApi<{ count: number; keys: PublicKey[]; entries: EvidenceRecord[] }>(`/workspaces/${workspace.id}/evidence?limit=1000`, { pollMs: 8000 });
  const check = useApi<{ ok: boolean; count: number; problems: string[] }>(`/workspaces/${workspace.id}/evidence/verify`, { pollMs: 15000 });
  const sharer = can(workspace.role, 'createShares');
  const shares = useApi<ShareRecord[]>(sharer ? `/workspaces/${workspace.id}/shares` : null);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ShareRecord | null>(null);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  const [form, setForm] = useState({ label: 'Klinikum Spree: quarterly audit', from: monthStart, to: new Date().toISOString().slice(0, 10), days: '7' });
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const s = await api<ShareRecord>(`/workspaces/${workspace.id}/shares`, {
        body: { label: form.label, periodFrom: `${form.from}T00:00:00.000Z`, periodTo: `${form.to}T23:59:59.999Z`, expiresAt: new Date(Date.now() + Number(form.days) * 86_400_000).toISOString() },
      });
      setCreated(s);
      setCreating(false);
      await shares.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (s: ShareRecord) => {
    await api(`/workspaces/${workspace.id}/shares/${s.id}/revoke`, { body: {} });
    toast(`"${s.label}" revoked. The link stops working now.`);
    await shares.reload();
  };
  const download = () => {
    if (!log.data) return;
    const pack = { workspace: workspace.name, exportedAt: new Date().toISOString(), keys: log.data.keys, records: [...log.data.entries].reverse().map(({ seq, headerJson, signature, bodyJson }) => ({ seq, headerJson, signature, bodyJson })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `lexcompiler-evidence-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Evidence"
        description="An append-only log. Every rule decision, check, exception and share is signed with Ed25519 and carries the hash of the record before it, so a removed or changed record is detectable."
        actions={
          <Button icon={<Download className="size-4" />} onClick={download} disabled={!log.data?.entries.length}>
            Download log
          </Button>
        }
      />
      {log.error && <ErrorNote>{log.error}</ErrorNote>}
      {!log.data ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <Card>
            <VerifyPanel records={log.data.entries} keys={log.data.keys} server={check.data} />
          </Card>

          {sharer && (
            <Card
              title="Share with an auditor or customer"
              description="A read-only link to the records of a period. No account needed; every view is logged, and you can revoke it."
              actions={
                <Button variant="primary" icon={<Link2 className="size-4" />} onClick={() => setCreating(true)}>
                  Create share link
                </Button>
              }
              padded={false}
            >
              {created?.url && (
                <div className="border-b border-zinc-100 p-5">
                  <Notice tone="green" icon={<Link2 className="size-4" />}>
                    <div className="font-medium">Share link for “{created.label}”. Copy it now: only a hash of it is stored.</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Mono className="break-all rounded bg-white px-2 py-1 text-zinc-800 ring-1 ring-emerald-200">{created.url}</Mono>
                      <CopyButton text={created.url} />
                      <a href={created.url} target="_blank" rel="noreferrer">
                        <Button size="sm" icon={<ExternalLink className="size-3.5" />}>Open</Button>
                      </a>
                    </div>
                  </Notice>
                </div>
              )}
              {!shares.data?.length ? (
                <EmptyState title="No share links yet" />
              ) : (
                <Table head={<><Th>Link</Th><Th>Period</Th><Th>Views</Th><Th>Expires</Th><Th /></>}>
                  {shares.data.map((s) => (
                    <tr key={s.id}>
                      <Td>
                        <div className="font-medium text-zinc-900">{s.label}</div>
                        <div className="text-xs text-zinc-500">by {s.createdByName ?? '—'} · {timeAgo(s.createdAt)}</div>
                      </Td>
                      <Td className="text-zinc-600">
                        {formatDate(s.periodFrom)} – {formatDate(s.periodTo)}
                      </Td>
                      <Td>{s.views}{s.lastViewedAt && <div className="text-xs text-zinc-500">last {timeAgo(s.lastViewedAt)}</div>}</Td>
                      <Td>{s.status === 'active' ? formatDate(s.expiresAt) : <Badge tone="gray">{s.status}</Badge>}</Td>
                      <Td className="text-right">{s.status === 'active' && <Button size="sm" variant="danger" onClick={() => revoke(s)}>Revoke</Button>}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          )}

          <Card title={`Records (${log.data.count})`} description="Newest first. Open a record to see exactly what was signed." padded={false}>
            {log.data.entries.length === 0 ? (
              <EmptyState icon={<FileCheck2 className="size-5" />} title="No records yet" description="Approving a rule, a check finishing, or an exception decision each adds a signed record." />
            ) : (
              <Table head={<><Th>#</Th><Th>Type</Th><Th>What happened</Th><Th>When</Th><Th>Header hash</Th></>}>
                {log.data.entries.map((e) => (
                  <React.Fragment key={e.seq}>
                    <tr className="cursor-pointer hover:bg-zinc-50" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                      <Td className="font-mono text-xs text-zinc-500">{e.seq}</Td>
                      <Td>
                        <Badge tone={TYPE_TONE[e.header.type] ?? 'gray'}>{e.header.type}</Badge>
                      </Td>
                      <Td className="text-zinc-800">{e.text}</Td>
                      <Td className="whitespace-nowrap text-xs text-zinc-500" >
                        <span title={new Date(e.header.at).toLocaleString()}>{timeAgo(e.header.at)}</span>
                      </Td>
                      <Td>
                        <Mono className="text-xs text-zinc-500">{e.headerSha256.slice(0, 12)}…</Mono>
                      </Td>
                    </tr>
                    {open === e.seq && (
                      <tr>
                        <td colSpan={5} className="bg-zinc-50 px-4 py-4">
                          <div className="grid gap-3 lg:grid-cols-2">
                            <CodeBlock label="Signed header" code={JSON.stringify(e.header, null, 2)} />
                            <CodeBlock label="Body (its SHA-256 is in the header)" code={JSON.stringify(e.body, null, 2)} />
                          </div>
                          <div className="mt-3 break-all font-mono text-xs text-zinc-500">signature (Ed25519, base64): {e.signature}</div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
      <Modal
        open={creating}
        title="Create a share link"
        description="The link shows every record in the period, signed, plus rule history and exceptions. Code snippets are never included."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={create} disabled={!form.label.trim()}>
              Create link
            </Button>
          </>
        }
      >
        <Field label="Name" htmlFor="share-label">
          <Input id="share-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="share-from">
            <Input id="share-from" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          </Field>
          <Field label="To" htmlFor="share-to">
            <Input id="share-to" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          </Field>
        </div>
        <Field label="Link expires after" htmlFor="share-days">
          <Select id="share-days" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </Select>
        </Field>
      </Modal>
    </>
  );
}
