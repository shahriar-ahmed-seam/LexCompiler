import { useState } from 'react';

/** Phase 6 controls on a rule in the lawyer's workspace: future effective dates and scope. */

/** An approved version that takes effect later: shows the date and lets Legal move it. */
export function EffectiveDateControl({ ruleKey, version, effectiveFrom, busy, onMove }: { ruleKey: string; version: number; effectiveFrom: string; busy: boolean; onMove: (date: string) => void }) {
  const [date, setDate] = useState(effectiveFrom.slice(0, 10));
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      <span className="text-amber-300">takes effect {effectiveFrom.slice(0, 10)}</span>
      <input type="date" aria-label={`New effective date for ${ruleKey} v${version}`} className="bg-[#0B101B] border border-zinc-700 rounded px-1" value={date} onChange={(e) => setDate(e.target.value)} />
      <button type="button" disabled={busy || !date} onClick={() => onMove(`${date}T00:00:00.000Z`)} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-0.5 disabled:opacity-50">
        Move date of {ruleKey} v{version}
      </button>
    </span>
  );
}

/** Drafts a new version of a rule with another scope: the whole workspace, or some counterparties. */
export function RescopeControl({ ruleKey, counterparties, busy, onRescope }: { ruleKey: string; counterparties: Array<{ id: string; name: string }>; busy: boolean; onRescope: (scope: { all: true } | { counterpartyIds: string[] }) => void }) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className="rounded bg-zinc-700 hover:bg-zinc-800 text-white px-2 py-0.5 text-xs disabled:opacity-50">
        Change scope of {ruleKey}
      </button>
    );
  }
  return (
    <fieldset className="text-xs space-y-1 border border-zinc-800 rounded p-2">
      <legend>Scope of the new {ruleKey} draft</legend>
      {counterparties.map((c) => (
        <label key={c.id} className="flex items-center gap-2">
          <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds((x) => (e.target.checked ? [...x, c.id] : x.filter((i) => i !== c.id)))} />
          {c.name}
        </label>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          onRescope(ids.length ? { counterpartyIds: ids } : { all: true });
          setOpen(false);
        }}
        className="rounded bg-sky-700 hover:bg-sky-800 text-white px-2 py-0.5 disabled:opacity-50"
      >
        {ids.length ? `Draft ${ruleKey} for these counterparties` : `Draft ${ruleKey} for the whole workspace`}
      </button>
    </fieldset>
  );
}
