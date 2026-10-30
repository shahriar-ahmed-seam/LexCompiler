import { CopyButton } from '../ui';

/** Code on a dark surface (checked against dark backgrounds by the contrast test). */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <span className="font-mono text-xs text-zinc-400">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[0.78rem] leading-relaxed text-zinc-100">{code}</pre>
    </div>
  );
}
