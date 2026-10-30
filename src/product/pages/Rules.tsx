import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, CircleHelp, FileText, Pencil, Plus, Scale, Sparkles } from 'lucide-react';
import { api, formatDate, formatHours, navigate, useApi } from '../api';
import { useSession } from '../ProductApp';
import { Badge, Button, Card, CodeBlock, EmptyState, ErrorNote, Field, Input, Link, Modal, Notice, PageHeader, RuleKey, Select, Spinner, Table, Td, Textarea, Th, cx, useToast } from '../ui';
import { can, type RuleCard, type RuleSummary, type RuleVersionSummary } from '../types';

export const CATEGORY_OPTIONS: Array<[string, string]> = [
  ['RETENTION_AND_TENANT_KMS', 'Retention and tenant keys'],
  ['ENCRYPTION_AT_REST', 'Encryption at rest'],
  ['PII_LOGGING_BAN', 'No personal data in logs'],
  ['RIGHT_TO_ERASURE_CASCADE', 'Right to erasure'],
  ['AI_HUMAN_IN_THE_LOOP', 'Human review of AI decisions'],
  ['CROSS_BORDER_TRANSFER', 'Data residency'],
  ['CONSENT_LAWFUL_BASIS', 'Consent and lawful basis'],
  ['BREACH_NOTIFICATION', 'Breach notification'],
  ['DPIA_REQUIRED', 'Impact assessment'],
  ['DATA_MINIMISATION', 'Data minimisation'],
  ['PURPOSE_LIMITATION', 'Purpose limitation'],
];

const EXAMPLES: Array<{ label: string; title: string; citation: string; text: string }> = [
  {
    label: 'Klinikum Spree DPA §4.2',
    title: 'Retention and tenant-isolated keys',
    citation: 'Klinikum Spree DPA §4.2',
    text: 'Section 4.2 (Data Retention & Cryptographic Isolation): All personal data and protected health information ingested via API endpoints, cached in memory workers, or persisted in relational tables must be encrypted at rest with tenant-isolated keys (per-tenant KMS envelope) and purged within 72 hours across all storage tiers.',
  },
  {
    label: 'Nodi addendum (Bangla)',
    title: 'গ্রাহকের তথ্য ৪৮ ঘণ্টায় মুছে ফেলা',
    citation: 'Nodi Microfinance addendum ধারা ২',
    text: 'ধারা ২: গ্রাহকের সকল ব্যক্তিগত তথ্য প্রতিটি টেন্যান্টের আলাদা KMS কী দিয়ে এনক্রিপ্ট করতে হবে এবং ৪৮ ঘণ্টার মধ্যে মুছে ফেলতে হবে।',
  },
  {
    label: 'Breach notice',
    title: 'Breach notification to the controller',
    citation: 'Klinikum Spree DPA §7.1',
    text: 'The processor shall notify the controller of a personal data breach without undue delay and in any event within 24 hours of becoming aware of it.',
  },
  {
    label: 'Unclear clause',
    title: 'Deletion after the contract ends',
    citation: 'Master services agreement §12',
    text: 'Customer data must be deleted promptly after the contract ends, or within one business day if the customer asks.',
  },
];

const FIELD_LABEL: Record<string, string> = { maxRetentionHours: 'Maximum retention', maxBreachNotificationHours: 'Breach notification deadline', minAiConfidenceThreshold: 'Human review below confidence' };
const fieldUnit = (field: string | null) => (field === 'minAiConfidenceThreshold' ? 'between 0 and 1' : 'hours');
const formatValue = (field: string | null, v: number | null) => (v == null ? '—' : field === 'minAiConfidenceThreshold' ? `${Math.round(v * 1000) / 10}%` : formatHours(v));

function versionStatus(v: RuleVersionSummary, retired: boolean) {
  if (retired && v.status === 'approved') return <Badge tone="gray">Retired</Badge>;
  if (v.inEffect) return <Badge tone="green" dot>In effect</Badge>;
  if (v.scheduled) return <Badge tone="blue" dot>From {formatDate(v.effectiveFrom)}</Badge>;
  if (v.status === 'draft') return <Badge tone="amber" dot>Waiting for approval</Badge>;
  if (v.status === 'rejected') return <Badge tone="red">Rejected</Badge>;
  return <Badge tone="gray">Superseded</Badge>;
}

export function RulesPage() {
  const { workspace } = useSession();
  const { data, error } = useApi<RuleSummary[]>(`/workspaces/${workspace.id}/rule-list`, { pollMs: 10000 });
  const editor = can(workspace.role, 'editRules');
  return (
    <>
      <PageHeader
        title="Rules"
        description="Obligations Legal approved from contracts and regulations. Every pull request is checked against the versions in effect."
        actions={
          editor ? (
            <Link to="/app/rules/new">
              <Button variant="primary" icon={<Plus className="size-4" />}>
                New rule
              </Button>
            </Link>
          ) : (
            <span className="text-sm text-zinc-500">Only Legal can add or approve rules.</span>
          )
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={<Scale className="size-5" />} title="No rules yet" description="Paste a clause from a contract or regulation. LexCompiler reads it, and Legal approves the reading." action={editor && <Link to="/app/rules/new"><Button variant="primary">Create the first rule</Button></Link>} />
        </Card>
      ) : (
        <Card padded={false}>
          <Table head={<><Th>Rule</Th><Th>What it requires</Th><Th>Status</Th><Th>Approved</Th></>}>
            {data.map((r) => {
              const v = r.current ?? r.latest;
              return (
                <tr key={r.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => navigate(`/app/rules/${r.id}`)}>
                  <Td className="w-[30%]">
                    <div className="flex items-center gap-2">
                      <RuleKey>{r.key}</RuleKey>
                      <span className="font-medium text-zinc-900">{r.title}</span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">{v.categoryLabel} · v{v.version}</div>
                  </Td>
                  <Td className="text-zinc-600">{v.requires}</Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      {versionStatus(v, Boolean(r.retiredAt))}
                      {r.hasDraft && v.status !== 'draft' && <Badge tone="amber">New version waiting</Badge>}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-zinc-500">
                    {r.current ? (
                      <>
                        <div className="text-zinc-700">{r.current.decidedBy ?? 'Legal'}</div>
                        <div className="text-xs">{formatDate(r.current.decidedAt)}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        </Card>
      )}
    </>
  );
}

function HighlightedText({ text, highlights }: { text: string; highlights: RuleCard['highlights'] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [i, h] of highlights.entries()) {
    if (h.start > at) parts.push(text.slice(at, h.start));
    const cls = h.kind === 'quote' ? 'rounded bg-emerald-100 px-0.5 text-emerald-900 ring-1 ring-emerald-300' : h.kind === 'value' ? 'rounded bg-amber-100 px-0.5 text-amber-900' : 'font-semibold text-indigo-700';
    parts.push(
      <mark key={i} className={cx('bg-transparent', cls)}>
        {text.slice(h.start, h.end)}
      </mark>
    );
    at = h.end;
  }
  parts.push(text.slice(at));
  return <p className="whitespace-pre-wrap text-[0.92rem] leading-relaxed text-zinc-800">{parts}</p>;
}

export function NewRulePage() {
  const { workspace } = useSession();
  const toast = useToast();
  const params = new URLSearchParams(window.location.search);
  const ruleId = params.get('ruleId');
  const existing = useApi<RuleSummary[]>(ruleId ? `/workspaces/${workspace.id}/rule-list` : null);
  const baseRule = existing.data?.find((r) => r.id === ruleId);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [citation, setCitation] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [card, setCard] = useState<RuleCard | null>(null);
  const [value, setValue] = useState('');
  // Today's date where the lawyer is (not UTC), as YYYY-MM-DD.
  const today = new Date().toLocaleDateString('en-CA');
  const [effective, setEffective] = useState(today);
  const [busy, setBusy] = useState<'analyze' | 'draft' | 'approve' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (baseRule && !text) {
      setText(baseRule.latest.sourceText);
      setTitle(baseRule.title);
      setCitation(baseRule.latest.citation);
    }
  }, [baseRule, text]);

  const analyze = async (cat: string | null = category) => {
    if (!text.trim()) return;
    setBusy('analyze');
    setError(null);
    try {
      const c = await api<RuleCard>(`/workspaces/${workspace.id}/rules/analyze`, { body: { text, ...(cat ? { category: cat } : {}) } });
      setCard(c);
      setCategory(c.category);
      setValue(c.value.value == null ? '' : String(c.value.value));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const field = card?.value.field ?? null;
  const numeric = value.trim() === '' ? null : Number(value);
  const valueMissing = Boolean(field) && (numeric === null || !Number.isFinite(numeric));
  const changedByLegal = Boolean(card && field && numeric !== null && numeric !== card.value.value);

  const save = async (approve: boolean) => {
    if (!card) return;
    setBusy(approve ? 'approve' : 'draft');
    setError(null);
    try {
      const values = field && numeric !== null ? { [field]: numeric } : {};
      const draft = await api<{ rule: { id: string; key: string }; version: { id: string; version: number } }>(`/workspaces/${workspace.id}/rules`, {
        body: { rawLegalText: text, title: title.trim() || card.categoryLabel, citation: citation.trim() || undefined, category: card.category, values, ...(ruleId ? { ruleId } : {}) },
      });
      if (approve) {
        await api(`/workspaces/${workspace.id}/rule-versions/${draft.version.id}/approve`, {
          body: {
            // Today means now; a later date means that day's start, local time.
            effectiveFrom: effective <= today ? new Date().toISOString() : new Date(`${effective}T00:00:00`).toISOString(),
            answers: { value: values, confirmed: card.value.status, question: card.value.question, parserValue: card.value.parserValue, ai: { model: card.ai.model, status: card.ai.status, value: card.value.modelValue, quote: card.value.quote }, changedByLegal },
          },
        });
        toast(`${draft.rule.key} v${draft.version.version} approved. The default branch and open pull requests are being re-checked.`);
      } else toast(`${draft.rule.key} v${draft.version.version} saved as a draft.`);
      navigate(`/app/rules/${draft.rule.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!can(workspace.role, 'editRules')) return <Notice tone="amber">Only Legal can create and approve rules.</Notice>;
  return (
    <>
      <Link to="/app/rules" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
        <ArrowLeft className="size-4" /> Rules
      </Link>
      <PageHeader title={baseRule ? `New version of ${baseRule.key}` : 'New rule'} description="Paste a clause. LexCompiler reads the obligation and shows what it would enforce. Nothing applies until you approve it." />
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-6">
          <Card title="Clause" description="From a contract, an addendum or a regulation, in English or Bangla.">
            <div className="space-y-4">
              {!baseRule && (
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((e) => (
                    <button
                      key={e.label}
                      type="button"
                      onClick={() => {
                        setText(e.text);
                        setTitle(e.title);
                        setCitation(e.citation);
                        setCard(null);
                        setCategory(null);
                      }}
                      className="cursor-pointer rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      <FileText className="mr-1 inline size-3" aria-hidden />
                      {e.label}
                    </button>
                  ))}
                </div>
              )}
              <Textarea aria-label="Clause text" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder="All personal data … must be purged within 72 hours …" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Title" htmlFor="title">
                  <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Retention and tenant keys" />
                </Field>
                <Field label="Source" htmlFor="citation">
                  <Input id="citation" value={citation} onChange={(e) => setCitation(e.target.value)} placeholder="Klinikum Spree DPA §4.2" />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === 'analyze'} disabled={!text.trim()} onClick={() => analyze(null)}>
                  Read the clause
                </Button>
              </div>
            </div>
          </Card>
          {card && (
            <Card title="Source, as read">
              <HighlightedText text={text} highlights={card.highlights} />
              <div className="mt-4 flex flex-wrap gap-3 text-xs text-zinc-500">
                <span><mark className="rounded bg-emerald-100 px-1 text-emerald-900 ring-1 ring-emerald-300">quote</mark> verified quote</span>
                <span><mark className="rounded bg-amber-100 px-1 text-amber-900">72 hours</mark> values</span>
                <span className="font-semibold text-indigo-700">must</span> obligation words
              </div>
            </Card>
          )}
        </div>

        <div className="lg:col-span-6">
          {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
          {!card ? (
            <Card>
              <EmptyState icon={<Scale className="size-5" />} title="The rule card appears here" description="Category, the value it enforces, what it requires in plain language, and the code that would fail today." />
            </Card>
          ) : (
            <Card
              title="Rule card"
              description="Check the reading, then approve it."
              actions={
                card.ai.status === 'ok' ? (
                  <Badge tone="violet" title={`${card.ai.tokens} tokens · ${(card.ai.latencyMs / 1000).toFixed(1)} s`}>
                    <Sparkles className="size-3" /> {card.ai.model}
                  </Badge>
                ) : card.ai.mode === 'off' ? (
                  <Badge tone="gray">AI off</Badge>
                ) : (
                  <Badge tone="amber" title={card.ai.detail ?? ''}>AI unavailable</Badge>
                )
              }
            >
              <div className="space-y-5">
                <Field label="Category" htmlFor="category" hint={card.category !== card.inferredCategory ? `LexCompiler read it as ${CATEGORY_OPTIONS.find((c) => c[0] === card.inferredCategory)?.[1]}.` : undefined}>
                  <Select id="category" value={category ?? card.category} onChange={(e) => void analyze(e.target.value)}>
                    {CATEGORY_OPTIONS.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>

                {field ? (
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
                    <div className="text-sm font-medium text-zinc-800">{FIELD_LABEL[field] ?? 'Value'}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <Input aria-label={FIELD_LABEL[field]} type="number" step="any" min="0" value={value} onChange={(e) => setValue(e.target.value)} className="w-36 text-base font-semibold" />
                      <span className="text-sm text-zinc-500">{fieldUnit(field)}</span>
                      {numeric !== null && Number.isFinite(numeric) && field !== 'minAiConfidenceThreshold' && numeric >= 48 && numeric % 24 === 0 && <span className="text-sm text-zinc-500">({numeric / 24} days)</span>}
                    </div>
                    <div className="mt-3 text-sm">
                      {changedByLegal ? (
                        <p className="flex gap-2 text-sky-800">
                          <Pencil className="mt-0.5 size-4 shrink-0" /> Set by you. LexCompiler read {formatValue(field, card.value.value)}; the approval records your change.
                        </p>
                      ) : card.value.status === 'confirmed' ? (
                        <p className="flex gap-2 text-emerald-800">
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                          <span>
                            {card.ai.status === 'ok' ? (
                              <>
                                Confirmed. {card.ai.model} read {formatValue(field, card.value.modelValue)} from “{card.value.quote}”. The quote is in the clause, and the parser read the same value.
                              </>
                            ) : (
                              <>Read by the parser: the clause states one value. {card.ai.mode === 'off' ? 'AI is off for this workspace.' : ''}</>
                            )}
                          </span>
                        </p>
                      ) : (
                        <p className="flex gap-2 text-amber-800">
                          <CircleHelp className="mt-0.5 size-4 shrink-0" />
                          <span>
                            <strong className="font-semibold">Question for you:</strong> {card.value.question} Enter the value to enforce.
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">This category has no number to set.</p>
                )}

                <div>
                  <div className="text-sm font-medium text-zinc-800">What it requires</div>
                  <p className="mt-1 rounded-lg border-l-2 border-indigo-300 bg-indigo-50/50 px-3 py-2 text-sm text-zinc-800">{card.plainReading}</p>
                </div>

                <div>
                  <div className="text-sm font-medium text-zinc-800">If you approve it today</div>
                  {card.impact.length === 0 ? (
                    <p className="mt-1 text-sm text-zinc-500">No scanned repository to preview against yet.</p>
                  ) : (
                    card.impact.map((i) => (
                      <div key={i.repoId} className="mt-2 rounded-lg border border-zinc-200 p-3">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="font-medium text-zinc-800">{i.repoFullName}</span>
                          {i.failing > 0 ? <Badge tone="red" dot>{i.failing} place{i.failing === 1 ? '' : 's'} would fail</Badge> : <Badge tone="green" dot>Already compliant</Badge>}
                        </div>
                        {i.locations.slice(0, 4).map((l, n) => (
                          <div key={n} className="mt-2 text-xs text-zinc-600">
                            <span className="font-mono text-zinc-800">
                              {l.filePath}:{l.line}
                            </span>{' '}
                            {l.explanation}
                          </div>
                        ))}
                        <div className="mt-2 text-xs text-zinc-500">Existing findings on the default branch are reported, not blocking. Only pull requests that add one are blocked.</div>
                      </div>
                    ))
                  )}
                </div>

                {card.reviewNotes.length > 0 && (
                  <Notice tone="amber">
                    {card.reviewNotes.map((n) => (
                      <div key={n}>{n}</div>
                    ))}
                  </Notice>
                )}

                <Field label="In effect from" htmlFor="effective" hint="A future date shows the rule as scheduled and warns pull requests until then.">
                  <Input id="effective" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className="w-48" />
                </Field>

                <details className="group rounded-lg border border-zinc-200">
                  <summary className="cursor-pointer select-none px-3 py-2 text-sm text-zinc-600">Formal policy (SMT-LIB2 and Rego)</summary>
                  <div className="space-y-3 p-3 pt-0">
                    <CodeBlock label="SMT-LIB2, proved with Z3" code={card.compiled.smtLib2} />
                    <CodeBlock label="Open Policy Agent (Rego)" code={card.compiled.rego} />
                  </div>
                </details>

                <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 pt-4">
                  <Button loading={busy === 'draft'} disabled={valueMissing || busy !== null} onClick={() => save(false)}>
                    Save draft
                  </Button>
                  <Button variant="primary" loading={busy === 'approve'} disabled={valueMissing || busy !== null} onClick={() => save(true)} icon={<CheckCircle2 className="size-4" />}>
                    Approve and enforce
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

export function RuleDetailPage({ ruleId }: { ruleId: string }) {
  const { workspace } = useSession();
  const toast = useToast();
  const { data, error, reload } = useApi<RuleSummary[]>(`/workspaces/${workspace.id}/rule-list`);
  const rule = useMemo(() => data?.find((r) => r.id === ruleId), [data, ruleId]);
  const [reject, setReject] = useState<RuleVersionSummary | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const editor = can(workspace.role, 'editRules');
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  if (!rule) return <EmptyState title="Rule not found" action={<Link to="/app/rules" className="text-sm font-medium text-indigo-600">All rules</Link>} />;
  const act = async (path: string, body: unknown, message: string) => {
    setBusy(true);
    try {
      await api(`/workspaces/${workspace.id}${path}`, { body });
      toast(message);
      setReject(null);
      setNote('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Link to="/app/rules" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
        <ArrowLeft className="size-4" /> Rules
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <RuleKey>{rule.key}</RuleKey> {rule.title}
          </span>
        }
        description={(rule.current ?? rule.latest).requires}
        actions={
          editor && (
            <>
              {!rule.retiredAt && rule.current && (
                <Button variant="danger" loading={busy} onClick={() => act(`/rules/${rule.id}/retire`, {}, `${rule.key} retired. Checks no longer enforce it.`)}>
                  Retire
                </Button>
              )}
              <Link to={`/app/rules/new?ruleId=${rule.id}`}>
                <Button icon={<Pencil className="size-4" />}>New version</Button>
              </Link>
            </>
          )
        }
      />
      <div className="space-y-4">
        {[...rule.versions].reverse().map((v) => (
          <Card
            key={v.id}
            title={
              <span className="flex items-center gap-2">
                Version {v.version} {versionStatus(v, Boolean(rule.retiredAt))}
              </span>
            }
            description={
              v.decidedAt
                ? `${v.status === 'rejected' ? 'Rejected' : 'Approved'} by ${v.decidedBy ?? 'Legal'} on ${formatDate(v.decidedAt, true)}${v.effectiveFrom && v.status === 'approved' ? ` · in effect from ${formatDate(v.effectiveFrom)}` : ''}`
                : `Drafted by ${v.createdBy ?? 'Legal'} on ${formatDate(v.createdAt, true)}`
            }
            actions={
              editor &&
              v.status === 'draft' && (
                <>
                  <Button size="sm" variant="danger" onClick={() => setReject(v)}>
                    Reject
                  </Button>
                  <Button size="sm" variant="primary" loading={busy} onClick={() => act(`/rule-versions/${v.id}/approve`, {}, `${rule.key} v${v.version} approved. Pull requests are being re-checked.`)}>
                    Approve
                  </Button>
                </>
              )
            }
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Source · {v.citation}</div>
                <blockquote className="mt-1.5 border-l-2 border-zinc-200 pl-3 text-sm leading-relaxed text-zinc-700">{v.sourceText}</blockquote>
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{v.categoryLabel}</div>
                  <p className="mt-1.5 text-zinc-800">{v.requires}</p>
                </div>
                {v.answers && (v.answers as { ai?: { model?: string; status?: string; value?: number } }).ai?.model && (
                  <p className="flex gap-2 text-zinc-600">
                    <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-500" />
                    Drafted with {(v.answers as { ai: { model: string } }).ai.model}; {(v.answers as { confirmed?: string }).confirmed === 'confirmed' ? 'its reading was confirmed by the parser before approval.' : 'Legal set the value.'}
                  </p>
                )}
                {v.note && <p className="text-zinc-600">Note: {v.note}</p>}
                <div className="font-mono text-xs text-zinc-500">clause sha256 {v.clauseSha256.slice(0, 16)}…</div>
              </div>
            </div>
            <details className="mt-4 rounded-lg border border-zinc-200">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm text-zinc-600">Formal policy (SMT-LIB2 and Rego)</summary>
              <div className="grid gap-3 p-3 pt-0 lg:grid-cols-2">
                <CodeBlock label="SMT-LIB2" code={v.smtLib2} />
                <CodeBlock label="Rego" code={v.rego} />
              </div>
            </details>
          </Card>
        ))}
      </div>
      <Modal
        open={Boolean(reject)}
        title={`Reject ${rule.key} v${reject?.version}`}
        description="The current version stays in effect."
        onClose={() => setReject(null)}
        footer={
          <>
            <Button onClick={() => setReject(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={() => reject && act(`/rule-versions/${reject.id}/reject`, { note }, `${rule.key} v${reject.version} rejected.`)}>
              Reject draft
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reject-note">
          <Textarea id="reject-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this reading is wrong" />
        </Field>
      </Modal>
    </>
  );
}
