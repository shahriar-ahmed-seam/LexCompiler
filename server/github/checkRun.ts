import type { ClassifiedFinding } from '../product/scanner.js';
import type { ScanSummary } from '../product/store.js';
import { githubText } from './markdown.js';

export const CHECK_NAME = 'LexCompiler / compliance';
export type CheckKind = 'pull_request' | 'push';
export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'action_required';

/** Annotations sent per scan. GitHub accepts 50 per request; each update adds more. */
const MAX_ANNOTATIONS = 150;

/**
 * Pull request: fails only for findings it adds; a rule Z3 could not decide needs review
 * (action_required, which blocks like a failure). Default branch: reports, never blocks; its
 * findings are the baseline later pull requests are compared against.
 */
export function checkConclusion(kind: CheckKind, summary: ScanSummary): CheckConclusion {
  if (kind === 'pull_request') {
    if (summary.newCount > 0) return 'failure';
    if (summary.undecidedRuleKeys.length > 0) return 'action_required';
    return 'success';
  }
  return summary.newCount + summary.existingCount > 0 || summary.undecidedRuleKeys.length > 0 ? 'neutral' : 'success';
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}
export interface CheckOutput {
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "1 January 2027" (UTC), as Legal wrote the date. */
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const cell = (s: string) => githubText(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const STATE_ORDER = { new: 0, existing: 1, waived: 2 } as const;
const LEVEL = { new: 'failure', existing: 'warning', waived: 'notice' } as const;

export function renderCheckOutput(input: {
  kind: CheckKind;
  summary: ScanSummary;
  findings: ClassifiedFinding[];
  rules: Array<{ ruleKey: string; title: string; version: number }>;
  detailsUrl: string;
  defaultBranch: string;
  filesScanned: number;
  truncated: boolean;
  lexcompilerVersion: string;
  /** "1 finding waived until 30 Nov 2026", shown under the counts. */
  waiverLine?: string | null;
  /** The signed evidence record of this scan, so the run (timestamped by GitHub) names it. */
  evidence?: { seq: number; headerSha256: string } | null;
  /** Approved versions not yet in effect, with what they would find: warnings, never failures. */
  upcoming?: Array<{ ruleKey: string; version: number; effectiveFrom: string; findings: Array<{ filePath: string; startLine: number; endLine: number; message: string }> }>;
  /** Approved exceptions behind waived findings, by exception id. */
  waivers?: Record<string, { expiresAt: string | null; reason: string; decidedBy: string | null }>;
}): CheckOutput {
  const { summary: s, kind, defaultBranch } = input;
  const titles = new Map(input.rules.map((r) => [r.ruleKey, r.title]));
  const newKeys = [...new Set(input.findings.filter((f) => f.state === 'new').map((f) => f.ruleKey))];
  let title: string;
  if (kind === 'pull_request') {
    if (s.newCount > 0) title = `${plural(s.newCount, 'new finding')} (${newKeys.join(', ')})`;
    else if (s.undecidedRuleKeys.length > 0) title = `Needs review: Z3 could not decide ${s.undecidedRuleKeys.join(', ')}`;
    else if (s.existingCount > 0) title = `No new findings · ${s.existingCount} already on ${defaultBranch}`;
    else title = `All ${plural(input.rules.length, 'rule')} pass`;
  } else {
    const open = s.newCount + s.existingCount;
    title = open > 0 ? `${plural(open, 'finding')} on ${defaultBranch} (baseline for pull requests)` : `All ${plural(input.rules.length, 'rule')} pass on ${defaultBranch}`;
  }

  const lines: string[] = [];
  const existingLabel = kind === 'pull_request' ? `existing (already on \`${defaultBranch}\`)` : 'open';
  lines.push(
    kind === 'pull_request'
      ? `**${s.newCount} new** · ${s.existingCount} ${existingLabel} · ${s.waivedCount} waived by an approved exception`
      : `**${s.existingCount + s.newCount} ${existingLabel}** · ${s.waivedCount} waived by an approved exception. A pull request fails only for findings it adds.`
  );
  if (input.waiverLine) lines.push('', input.waiverLine);
  if (s.undecidedRuleKeys.length > 0) {
    lines.push('', `⚠️ Z3 could not decide ${s.undecidedRuleKeys.join(', ')} within its time limit. These rules are not counted as passing; ask Legal to review.`);
  }
  lines.push('', '| Rule | Title | New | Existing | Waived |', '| :-- | :-- | --: | --: | --: |');
  for (const r of input.rules) {
    const row = s.perRule.find((p) => p.ruleKey === r.ruleKey);
    lines.push(`| ${r.ruleKey} v${r.version} | ${cell(r.title)} | ${row?.newCount ?? 0} | ${row?.existingCount ?? 0} | ${row?.waivedCount ?? 0} |`);
  }
  const upcoming = (input.upcoming ?? []).filter((u) => u.findings.length > 0);
  if (upcoming.length > 0) {
    lines.push('', '### Coming up', '');
    for (const u of upcoming) lines.push(`- **${u.ruleKey} v${u.version}** takes effect on ${longDate(u.effectiveFrom)}: ${plural(u.findings.length, 'finding')} here will fail from then.`);
  }
  const newFindings = input.findings.filter((f) => f.state === 'new');
  if (newFindings.length > 0) {
    lines.push('', '### New findings', '');
    for (const f of newFindings.slice(0, 30)) lines.push(`- **${f.ruleKey}** \`${f.filePath}:${f.startLine}\`: ${cell(f.message)}`);
    if (newFindings.length > 30) lines.push(`- …and ${newFindings.length - 30} more`);
    if (kind === 'pull_request') lines.push('', 'If a finding is acceptable for now, use **Request exception** above: Legal decides in LexCompiler, and the check re-runs.');
  }
  const waived = input.findings.filter((f) => f.state === 'waived');
  if (waived.length > 0) {
    lines.push('', '### Waived by Legal', '');
    for (const f of waived.slice(0, 30)) {
      const w = f.exceptionId ? input.waivers?.[f.exceptionId] : undefined;
      const until = w?.expiresAt ? ` until ${w.expiresAt.slice(0, 10)}` : '';
      const by = w?.decidedBy ? `, approved by ${cell(w.decidedBy)}` : '';
      lines.push(`- **${f.ruleKey}** \`${f.filePath}:${f.startLine}\`: waived${until}${by}.${w?.reason ? ` Reason: ${cell(w.reason)}` : ''}`);
    }
  }
  lines.push('', `[Open this scan in LexCompiler](${input.detailsUrl})`);
  if (input.truncated) lines.push('', '_This repository has more source files than one scan reads; some files were not checked._');
  lines.push(
    '',
    // Plain Markdown, no HTML: GitHub echoes this summary in check_run webhooks, and relays that
    // re-encode JSON (smee) break the signature of bodies containing <, > or &.
    `_${plural(input.filesScanned, 'source file')} scanned · rules ${input.rules.map((r) => `${r.ruleKey} v${r.version}`).join(', ')} · LexCompiler ${input.lexcompilerVersion}_`
  );
  if (input.evidence) lines.push('', `Evidence record #${input.evidence.seq} · header SHA-256 \`${input.evidence.headerSha256}\``);

  const upcomingAnnotations = upcoming.flatMap((u) =>
    u.findings.map(
      (f): CheckAnnotation => ({
        path: f.filePath,
        start_line: f.startLine,
        end_line: Math.max(f.startLine, f.endLine),
        annotation_level: 'warning',
        title: `${u.ruleKey} v${u.version} · from ${longDate(u.effectiveFrom)}`.slice(0, 255),
        message: `Will fail from ${longDate(u.effectiveFrom)}: ${githubText(f.message)}`.slice(0, 4000),
      })
    )
  );
  const annotations = [...input.findings]
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
    .slice(0, MAX_ANNOTATIONS)
    .map(
      (f): CheckAnnotation => ({
        path: f.filePath,
        start_line: f.startLine,
        end_line: Math.max(f.startLine, f.endLine),
        annotation_level: LEVEL[f.state],
        title: `${f.ruleKey} · ${githubText(titles.get(f.ruleKey) ?? '')}`.slice(0, 255),
        message: (f.state === 'existing' ? `${githubText(f.message)} (already on ${defaultBranch})` : f.state === 'waived' ? `${githubText(f.message)} (waived by an approved exception)` : githubText(f.message)).slice(0, 4000),
      })
    )
    .concat(upcomingAnnotations)
    .slice(0, MAX_ANNOTATIONS);
  if (upcoming.length > 0 && !title.includes('new finding')) title = `${title} · ${upcoming.map((u) => `${u.ruleKey} v${u.version}`).join(', ')} will fail from ${longDate(upcoming[0].effectiveFrom)}`;
  return { title: title.slice(0, 255), summary: lines.join('\n').slice(0, 65000), annotations };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
