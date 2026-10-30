import { CheckCircle2, FileCheck2, GitPullRequest, Scale, XCircle } from 'lucide-react';

/** The dark panel beside the sign-in form (checked against dark backgrounds by the contrast test). */
export function LoginHero() {
  return (
    <div className="relative hidden overflow-hidden bg-zinc-950 lg:block">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px]" aria-hidden />
      <div className="relative flex h-full flex-col justify-center px-16">
        <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight text-white">Contracts, enforced in code review.</h2>
        <ul className="mt-6 max-w-md space-y-3 text-[0.95rem] text-zinc-300">
          <li className="flex gap-3">
            <Scale className="mt-0.5 size-4 shrink-0 text-indigo-400" aria-hidden /> Legal turns contract clauses into rules, and approves every one.
          </li>
          <li className="flex gap-3">
            <GitPullRequest className="mt-0.5 size-4 shrink-0 text-indigo-400" aria-hidden /> Every pull request is checked against them, before it merges.
          </li>
          <li className="flex gap-3">
            <FileCheck2 className="mt-0.5 size-4 shrink-0 text-indigo-400" aria-hidden /> Every decision is signed, so auditors can verify it themselves.
          </li>
        </ul>
        <div className="mt-12 max-w-md rounded-xl border border-white/10 bg-white/[0.04] p-4 font-mono text-[0.8rem] text-zinc-300 shadow-2xl">
          <div className="mb-3 flex items-center justify-between text-xs text-zinc-400">
            <span>Checks</span>
            <span>pull request · feat/loan-applications</span>
          </div>
          <div className="flex items-center gap-2.5 py-1.5">
            <XCircle className="size-4 text-rose-400" aria-hidden />
            <span className="text-zinc-100">LexCompiler / compliance</span>
            <span className="ml-auto text-zinc-400">1 new finding</span>
          </div>
          <div className="ml-6.5 border-l border-white/10 pl-3 text-xs leading-relaxed text-zinc-400">Retention and tenant keys · api/loan_applications.py:20</div>
          <div className="mt-2 flex items-center gap-2.5 py-1.5">
            <CheckCircle2 className="size-4 text-emerald-400" aria-hidden />
            <span className="text-zinc-100">LexCompiler / compliance</span>
            <span className="ml-auto text-zinc-400">waived by Legal</span>
          </div>
        </div>
      </div>
    </div>
  );
}
