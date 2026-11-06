import { diffLines } from 'diff';
import { scopedRules } from '../product/repoScan.js';
import { scanFilesScoped, type ClassifiedFinding } from '../product/scanner.js';
import type { ProductStore, Repo, RuleInEffect } from '../product/store.js';
import { synthesizeRemediationPullRequest } from '../remediation/prSynthesizer.js';
import type { RemediationPullRequest, TargetRepoFile } from '../../shared/types.js';
import { GitHubApiError, type GitHubApp } from './client.js';
import { readTarballSources } from './tarball.js';
import { aiSuggestionsFor } from './aiFixes.js';
import type { AiGateway } from '../ai/gateway.js';

/**
 * Fixes on GitHub (product guide, Phase 4, items 1 and 2), with the installation token:
 * - a fix pull request for the default branch, as one commit made through the Git Data API, and
 *   only for a remediation bundle that passed the Z3 gate (READY_TO_MERGE);
 * - `suggestion` review comments on pull requests, for new findings whose verified fix replaces
 *   lines the pull request changed. Findings elsewhere stay as annotations.
 */

export class FixPrError extends Error {
  constructor(
    message: string,
    readonly status = 409
  ) {
    super(message);
  }
}

export interface FixPrResult {
  created: boolean;
  prNumber: number;
  url: string;
  branch: string;
  baseSha: string;
  commitSha: string;
  files: string[];
  addressed: string[];
}

/** The remediation bundle for these files and rules, or null when nothing fails. */
async function remediate(files: TargetRepoFile[], rules: RuleInEffect[], globs: Map<string, string[]>): Promise<RemediationPullRequest | null> {
  if (rules.length === 0) return null;
  const scan = await scanFilesScoped(files, rules, globs);
  return synthesizeRemediationPullRequest(
    rules.map((r) => r.clause),
    files,
    scan.proofs
  );
}

/**
 * Opens a fix pull request for the repository's default branch: one commit with every patched
 * file, on a new branch. A second request for the same base commit returns the first PR.
 */
export async function openFixPullRequest(deps: { store: ProductStore; app: GitHubApp }, repo: Repo, requestedBy: string): Promise<FixPrResult> {
  const { store, app } = deps;
  if (repo.source !== 'github' || repo.installationId === null || !repo.workspaceId) throw new FixPrError('fix pull requests are opened on GitHub repositories');
  const inst = repo.installationId;
  const route = `/repos/${repo.fullName}`;
  const head = await app.request<{ sha: string }>(inst, 'GET', `${route}/commits/${encodeURIComponent(repo.defaultBranch)}`);
  const existing = store.getFixPr(repo.id, head.sha);
  if (existing) return { ...existing, created: false };

  const { files } = await readTarballSources(await app.downloadTarball(inst, repo.fullName, head.sha));
  const { rules, globs } = scopedRules(store, repo, store.rulesInEffect(repo.workspaceId));
  const bundle = await remediate(files, rules, globs);
  if (!bundle) throw new FixPrError(`${repo.defaultBranch} passes every rule in effect; there is nothing to fix`);
  if (bundle.status !== 'READY_TO_MERGE' || bundle.postPatchZ3Status !== 'SAT_COMPLIANT') {
    const why = [...(bundle.unresolvedClauseIds ?? []).map((k) => `${k} is not proven after the patch`), ...(bundle.validationErrors ?? [])];
    throw new FixPrError(`No verified fix: the patch did not pass the Z3 gate${why.length ? ` (${why.join('; ')})` : ''}. Fix these by hand or ask Legal for an exception.`);
  }

  // One commit: a blob per patched file, a tree on top of the base commit's tree, the commit, the branch.
  const base = await app.request<{ sha: string; tree: { sha: string } }>(inst, 'GET', `${route}/git/commits/${head.sha}`);
  const tree = [];
  for (const p of bundle.filePatches) {
    let blob: { sha: string };
    try {
      blob = await app.request<{ sha: string }>(inst, 'POST', `${route}/git/blobs`, { content: p.patchedContent, encoding: 'utf-8' });
    } catch (err) {
      // Apps registered before fix PRs existed have Contents: read only.
      if (err instanceof GitHubApiError && err.status === 403) {
        throw new FixPrError("The GitHub App can't write to this repository. In the App's settings on GitHub, set Permissions → Repository → Contents to \"Read and write\", then accept the new permission on the installation.", 403);
      }
      throw err;
    }
    tree.push({ path: p.filePath, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await app.request<{ sha: string }>(inst, 'POST', `${route}/git/trees`, { base_tree: base.tree.sha, tree });
  const addressed = bundle.addressedClauses.map((c) => c.clauseId);
  const message = `${bundle.title}\n\nRules: ${addressed.join(', ')}. Z3 proves each rule after this change (${bundle.postPatchZ3Status}).\nOpened by LexCompiler for ${requestedBy}.`;
  const commit = await app.request<{ sha: string }>(inst, 'POST', `${route}/git/commits`, { message, tree: newTree.sha, parents: [head.sha] });
  let branch = `lexcompiler/fix-${head.sha.slice(0, 7)}`;
  try {
    await app.request(inst, 'POST', `${route}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
    branch = `${branch}-${Date.now().toString(36)}`;
    await app.request(inst, 'POST', `${route}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  const body = [
    `LexCompiler found ${bundle.addressedViolationsCount} violations on \`${repo.defaultBranch}\` (${head.sha.slice(0, 7)}) and fixed them in one commit.`,
    '',
    '| File | Change |',
    '| :-- | :-- |',
    ...bundle.filePatches.map((p) => `| \`${p.filePath}\` | ${p.summary.replace(/\|/g, '\\|')} |`),
    '',
    `Rules: ${bundle.addressedClauses.map((c) => `**${c.clauseId}** ${c.title}`).join(', ')}.`,
    `Z3 proves every rule after the patch (${bundle.postPatchZ3Status}), and every patched file still parses. The check on this pull request runs the same proof on GitHub's copy.`,
    '',
    `_Requested by ${requestedBy}._`,
  ].join('\n');
  const pr = await app.request<{ number: number; html_url: string }>(inst, 'POST', `${route}/pulls`, {
    title: bundle.title,
    head: branch,
    base: repo.defaultBranch,
    body,
  });
  const result = { prNumber: pr.number, url: pr.html_url, branch, baseSha: head.sha, commitSha: commit.sha, files: bundle.filePatches.map((p) => p.filePath), addressed };
  store.recordFixPr({ repoId: repo.id, ...result, requestedBy });
  return { ...result, created: true };
}

// ---------------------------------------------------------------- suggested changes

/** Lines on the new side of a pull request's diff, per file (GitHub accepts review comments only there). */
export function diffLinesByFile(files: Array<{ filename: string; patch?: string }>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    const lines = new Set<number>();
    let right = 0;
    for (const line of (f.patch ?? '').split('\n')) {
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        right = Number(h[1]);
        continue;
      }
      if (line.startsWith('-') || line.startsWith('\\')) continue;
      if (line.startsWith('+') || line.startsWith(' ')) lines.add(right++);
    }
    out.set(f.filename, lines);
  }
  return out;
}

/** The changed regions between two versions of a file: original lines start..end (inclusive) become `replacement`. */
export function changedHunks(original: string, patched: string): Array<{ start: number; end: number; replacement: string[] }> {
  const hunks: Array<{ start: number; end: number; replacement: string[] }> = [];
  let line = 1;
  let open: { start: number; end: number; replacement: string[] } | null = null;
  const toLines = (v: string) => v.replace(/\n$/, '').split('\n');
  for (const part of diffLines(original, patched)) {
    const n = part.count ?? toLines(part.value).length;
    if (part.removed) {
      open ??= { start: line, end: line - 1, replacement: [] };
      open.end = line + n - 1;
      line += n;
    } else if (part.added) {
      open ??= { start: line, end: line - 1, replacement: [] };
      open.replacement.push(...toLines(part.value));
    } else {
      if (open) hunks.push(open);
      open = null;
      line += n;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

export interface Suggestion {
  fingerprint: string;
  ruleKey: string;
  path: string;
  startLine: number;
  line: number;
  body: string;
}

/**
 * Suggestions for new findings: the rule's verified fix (Z3 SAT_COMPLIANT after the patch) when
 * it is one replacement of lines inside the pull request's diff around the finding. Anything
 * else (a helper added elsewhere, lines outside the diff, no verified fix) stays an annotation.
 */
export async function suggestionsFor(input: {
  files: TargetRepoFile[];
  findings: ClassifiedFinding[];
  rules: RuleInEffect[];
  globs: Map<string, string[]>;
  diffLines: Map<string, Set<number>>;
  alreadyCommented: Set<string>;
}): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const fresh = input.findings.filter((f) => f.state === 'new' && !input.alreadyCommented.has(f.fingerprint) && input.diffLines.has(f.filePath));
  for (const ruleKey of [...new Set(fresh.map((f) => f.ruleKey))]) {
    const rule = input.rules.find((r) => r.ruleKey === ruleKey);
    if (!rule) continue;
    const bundle = await remediate(input.files, [rule], input.globs);
    if (!bundle || bundle.status !== 'READY_TO_MERGE' || bundle.postPatchZ3Status !== 'SAT_COMPLIANT') continue;
    for (const f of fresh.filter((x) => x.ruleKey === ruleKey)) {
      const patch = bundle.filePatches.find((p) => p.filePath === f.filePath);
      if (!patch) continue;
      const hunks = changedHunks(patch.originalContent, patch.patchedContent);
      // One replacement, of lines that exist, around the finding, all inside the PR's diff.
      if (hunks.length !== 1) continue;
      const h = hunks[0];
      const inDiff = input.diffLines.get(f.filePath)!;
      if (h.end < h.start || h.end < f.startLine || h.start > f.endLine) continue;
      let ok = true;
      for (let l = h.start; l <= h.end; l++) if (!inDiff.has(l)) ok = false;
      if (!ok) continue;
      out.push({
        fingerprint: f.fingerprint,
        ruleKey,
        path: f.filePath,
        startLine: h.start,
        line: h.end,
        body: [
          `**${ruleKey}** · ${rule.clause.title}`,
          '',
          f.message,
          '',
          '```suggestion',
          ...h.replacement,
          '```',
          '',
          `_LexCompiler: Z3 proves ${ruleKey} after this change._`,
        ].join('\n'),
      });
    }
  }
  return out;
}

/**
 * Posts suggestions on a pull request as one review (event COMMENT), skipping findings already
 * commented on in this pull request. Returns how many comments were posted.
 */
export async function postSuggestions(
  deps: { store: ProductStore; app: GitHubApp },
  input: {
    repo: Repo;
    prNumber: number;
    headSha: string;
    files: TargetRepoFile[];
    findings: ClassifiedFinding[];
    rules: RuleInEffect[];
    globs: Map<string, string[]>;
    /** AI explanations by fingerprint, appended to the comment (5.5). */
    explanations?: Map<string, string>;
    /** Model-written fixes for findings without a template fix (5.5 item 2; cloud mode only). */
    ai?: { gateway: AiGateway; workspaceId: string };
  }
): Promise<number> {
  const { store, app } = deps;
  const { repo } = input;
  if (repo.installationId === null || !input.findings.some((f) => f.state === 'new')) return 0;
  const route = `/repos/${repo.fullName}`;
  const changed: Array<{ filename: string; patch?: string }> = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await app.request<Array<{ filename: string; patch?: string }>>(repo.installationId, 'GET', `${route}/pulls/${input.prNumber}/files?per_page=100&page=${page}`);
    changed.push(...batch);
    if (batch.length < 100) break;
  }
  const diff = diffLinesByFile(changed);
  const alreadyCommented = store.suggestedFingerprints(repo.id, input.prNumber);
  const suggestions = await suggestionsFor({ files: input.files, findings: input.findings, rules: input.rules, globs: input.globs, diffLines: diff, alreadyCommented });
  if (input.ai) {
    const covered = new Set([...alreadyCommented, ...suggestions.map((s) => s.fingerprint)]);
    const remaining = input.findings.filter((f) => f.state === 'new' && !covered.has(f.fingerprint) && diff.has(f.filePath));
    suggestions.push(
      ...(await aiSuggestionsFor({ ai: input.ai.gateway, workspaceId: input.ai.workspaceId, files: input.files, findings: remaining, allFindings: input.findings, rules: input.rules, globs: input.globs, diffLines: diff }))
    );
  }
  if (suggestions.length === 0) return 0;
  await app.request(repo.installationId, 'POST', `${route}/pulls/${input.prNumber}/reviews`, {
    commit_id: input.headSha,
    event: 'COMMENT',
    body: `LexCompiler suggests ${suggestions.length === 1 ? 'a fix' : `${suggestions.length} fixes`} for new findings. Each one is proven with Z3 before it is offered.`,
    comments: suggestions.map((s) => ({
      path: s.path,
      body: input.explanations?.has(s.fingerprint) ? `${s.body}\n\n${input.explanations.get(s.fingerprint)}` : s.body,
      side: 'RIGHT',
      line: s.line,
      ...(s.startLine < s.line ? { start_line: s.startLine, start_side: 'RIGHT' } : {}),
    })),
  });
  for (const s of suggestions) store.recordSuggestion(repo.id, input.prNumber, s.fingerprint);
  return suggestions.length;
}
