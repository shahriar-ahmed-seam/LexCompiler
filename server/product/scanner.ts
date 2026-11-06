import { analyzeFullRepositoryAsync } from '../analyzer/astAnalyzer.js';
import { verifyRepositoryAgainstClauses } from '../prover/z3Engine.js';
import { sha256Hex } from '../util/hash.js';
import type { ClauseVerificationProof, TargetRepoFile } from '../../shared/types.js';
import type { RuleInEffect } from './store.js';

/** One place where one rule fails. */
export interface RawFinding {
  ruleId: string;
  ruleKey: string;
  ruleVersionId: string;
  fingerprint: string;
  filePath: string;
  startLine: number;
  endLine: number;
  constructType: string;
  message: string;
  snippet: string;
}

export type FindingState = 'new' | 'existing' | 'waived';
export interface ClassifiedFinding extends RawFinding {
  state: FindingState;
  exceptionId: string | null;
}

export interface FileScanResult {
  findings: RawFinding[];
  /** Rules Z3 could not decide (timeout or unknown); never counted as compliant. */
  undecidedRuleKeys: string[];
  proofs: ClauseVerificationProof[];
  filesScanned: number;
  facts: { sqlTables: unknown[]; astFindings: unknown[] };
}

/**
 * Identity of a finding across commits: rule, file, construct and the code itself, but not the
 * line number, so a finding keeps its identity when code above it moves.
 */
export function findingFingerprint(ruleKey: string, filePath: string, constructType: string, snippet: string): string {
  return sha256Hex([ruleKey, filePath, constructType, snippet.replace(/\s+/g, ' ').trim()].join('\u0000'));
}

/** Analyzes files (parsing only, never executing them) and proves them against the rules. */
export async function scanFiles(files: TargetRepoFile[], rules: RuleInEffect[]): Promise<FileScanResult> {
  const analysis = await analyzeFullRepositoryAsync(files);
  if (rules.length === 0) {
    return { findings: [], undecidedRuleKeys: [], proofs: [], filesScanned: files.length, facts: { sqlTables: analysis.sqlTables, astFindings: analysis.astFindings } };
  }
  const byKey = new Map(rules.map((r) => [r.ruleKey, r]));
  const { proofs } = await verifyRepositoryAgainstClauses(
    rules.map((r) => r.clause),
    analysis.sqlTables,
    analysis.astFindings
  );
  const seen = new Set<string>();
  const findings: RawFinding[] = [];
  const undecided: string[] = [];
  for (const proof of proofs) {
    const rule = byKey.get(proof.clauseId);
    if (!rule) continue;
    if (proof.status === 'UNKNOWN_NEEDS_REVIEW') undecided.push(rule.ruleKey);
    if (proof.status !== 'UNSAT_VIOLATION') continue;
    for (const loc of proof.offendingLocations) {
      const constructType = loc.astNodeType || loc.nodeId;
      const snippet = loc.codeSnippet || '';
      const fingerprint = findingFingerprint(rule.ruleKey, loc.filePath, constructType, snippet);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      findings.push({
        ruleId: rule.ruleId,
        ruleKey: rule.ruleKey,
        ruleVersionId: rule.versionId,
        fingerprint,
        filePath: loc.filePath,
        startLine: Math.max(1, loc.line || 1),
        endLine: Math.max(loc.line || 1, loc.endLine || loc.line || 1),
        constructType,
        message: loc.explanation,
        snippet,
      });
    }
  }
  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.ruleKey.localeCompare(b.ruleKey));
  return {
    findings,
    undecidedRuleKeys: [...new Set(undecided)],
    proofs,
    filesScanned: files.length,
    facts: { sqlTables: analysis.sqlTables, astFindings: analysis.astFindings },
  };
}

/**
 * Scans with each rule limited to its path globs (product guide, Phase 6, scope by path): a rule
 * is proven only against facts from the files in its scope, so code outside a counterparty's
 * paths can neither fail nor satisfy that counterparty's rule. Rules with the same globs are
 * proven together. `globs` maps a rule key to its globs; a missing key means the whole repository.
 */
export async function scanFilesScoped(files: TargetRepoFile[], rules: RuleInEffect[], globs: Map<string, string[]>): Promise<FileScanResult> {
  const groups = new Map<string, { globs: string[]; rules: RuleInEffect[] }>();
  for (const r of rules) {
    const g = [...new Set(globs.get(r.ruleKey) ?? ['**'])].sort();
    const key = g.join('\n');
    const group = groups.get(key) ?? { globs: g, rules: [] };
    group.rules.push(r);
    groups.set(key, group);
  }
  const whole = groups.get('**');
  // The facts of the whole repository are kept with the scan (impact previews read them).
  const results = await Promise.all(
    [...groups.values()].map(async (group) => {
      const subset = group.globs.includes('**') ? files : files.filter((f) => group.globs.some((g) => globMatch(g, f.path)));
      const result = await scanFiles(subset, group.rules);
      return { ...result, findings: result.findings.filter((f) => group.globs.some((g) => globMatch(g, f.filePath))) };
    })
  );
  const facts = whole ? results[[...groups.keys()].indexOf('**')].facts : (await scanFiles(files, [])).facts;
  const findings = results.flatMap((r) => r.findings);
  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.ruleKey.localeCompare(b.ruleKey));
  return {
    findings,
    undecidedRuleKeys: [...new Set(results.flatMap((r) => r.undecidedRuleKeys))],
    proofs: results.flatMap((r) => r.proofs),
    filesScanned: files.length,
    facts,
  };
}

/** An approved exception that waives findings until it expires. */
export interface ActiveException {
  id: string;
  ruleId: string;
  fingerprint: string | null;
  pathGlob: string | null;
  expiresAt?: string | null;
}

/**
 * New = not on the baseline commit. Existing = already on the baseline (or no baseline was given,
 * e.g. a scan of the default branch). Waived = covered by an approved exception.
 */
export function classifyFindings(head: RawFinding[], base: RawFinding[] | null, exceptions: ActiveException[] = []): ClassifiedFinding[] {
  const baseFingerprints = base ? new Set(base.map((f) => f.fingerprint)) : null;
  return head.map((f) => {
    const exception = exceptions.find(
      (e) => e.ruleId === f.ruleId && (e.fingerprint ? e.fingerprint === f.fingerprint : e.pathGlob ? globMatch(e.pathGlob, f.filePath) : false)
    );
    if (exception) return { ...f, state: 'waived', exceptionId: exception.id };
    const state: FindingState = baseFingerprints && !baseFingerprints.has(f.fingerprint) ? 'new' : 'existing';
    return { ...f, state, exceptionId: null };
  });
}

/** Minimal glob: `**` matches any path, `*` matches within one path segment. */
export function globMatch(glob: string, filePath: string): boolean {
  const pattern = glob
    .trim()
    .replace(/^\/+/, '')
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(filePath);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
