import type { AiGateway } from '../ai/gateway.js';
import { aiSuggestionsFor } from '../github/aiFixes.js';
import { scopedRules } from '../product/repoScan.js';
import { classifyFindings, scanFilesScoped } from '../product/scanner.js';
import { StoreError, type ProductStore, type Repo } from '../product/store.js';
import type { TargetRepoFile } from '../../shared/types.js';
import { runCrew, type CrewPullRequest, type CrewRun, type CrewRunStore } from './crew.js';

/**
 * The crew on a workspace's repository (HANDOFF, agent crew item 4): the rules in effect for that
 * repository (each on its scope's paths), the files of its default branch, and, when asked, a real pull request for a patch
 * that passed the Z3 gate (item 3), opened through the product's fix-PR path.
 */
export interface WorkspaceCrewDeps {
  store: ProductStore;
  runs: CrewRunStore;
  /** The default branch's head commit and files (a local repository's working tree is "working-tree"). */
  readHead: (repo: Repo) => Promise<{ commitSha: string; files: TargetRepoFile[] }>;
  /** Opens the verified fix pull request (openFixPullRequest); absent without a GitHub App. */
  openFixPr?: (repo: Repo, requestedBy: string) => Promise<CrewPullRequest>;
  /** The fix agent: model-written fixes when the template patch fails the gate (workspace AI on cloud). */
  ai?: AiGateway;
  runCrew?: typeof runCrew;
}

/** A model-written fix the crew's checks kept: the file parses, Z3 no longer finds the rule there, the rescan finds nothing new. */
export interface ModelFix {
  ruleKey: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Review text with the replacement as a `suggestion` block. */
  body: string;
}

export async function runWorkspaceCrew(
  deps: WorkspaceCrewDeps,
  repo: Repo,
  opts: { useModels: boolean; openPullRequest: boolean; requestedBy: string; triggeredBy: string | null; allRules?: boolean }
): Promise<CrewRun> {
  if (!repo.workspaceId) throw new StoreError('the repository is not linked to a workspace', 409);
  if (opts.openPullRequest && repo.source !== 'github') throw new StoreError('pull requests are opened on GitHub repositories; apply the patch to a local folder by hand', 409);
  if (opts.openPullRequest && !deps.openFixPr) throw new StoreError('the GitHub App is not configured on this server', 503);
  const { rules, globs } = scopedRules(deps.store, repo, deps.store.rulesInEffect(repo.workspaceId));
  if (rules.length === 0) throw new StoreError(`no approved rule is in effect for ${repo.fullName}`, 409);
  const { commitSha, files } = await deps.readHead(repo);
  const run = await (deps.runCrew ?? runCrew)(
    rules.map((r) => r.clause),
    {
      useModels: opts.useModels,
      files,
      // Each rule is checked only on its scope's paths in this repository (counterparty paths).
      globs,
      allRules: opts.allRules,
      triggeredBy: opts.triggeredBy,
      target: { workspaceId: repo.workspaceId, repoId: repo.id, repoFullName: repo.fullName, commitSha },
      openPullRequest: opts.openPullRequest && deps.openFixPr ? () => deps.openFixPr!(repo, opts.requestedBy) : undefined,
    }
  );
  // The fix agent (guide 5.7): where the template patch didn't pass the gate, the workspace's model
  // may fix the remaining findings one by one. Each fix is checked like a PR suggestion (#16) and
  // kept only if it holds; the fixes are suggestions in the run, never committed or opened as a PR.
  const remediation = run.steps[5];
  if (deps.ai && run.gate === 'PATCH_BLOCKED' && remediation?.status === 'COMPLETED') {
    const unsat = new Set(((run.steps[4].handoff.unsat as Array<{ clauseId: string }> | undefined) || []).map((u) => u.clauseId));
    const scan = await scanFilesScoped(files, rules, globs);
    const findings = classifyFindings(scan.findings, null).filter((f) => unsat.has(f.ruleKey));
    const everyLine = new Map(files.map((f) => [f.path, new Set(f.content.split('\n').map((_, i) => i + 1))]));
    const fixes = await aiSuggestionsFor({ ai: deps.ai, workspaceId: repo.workspaceId, files, findings, allFindings: classifyFindings(scan.findings, null), rules, globs, diffLines: everyLine });
    const modelFixes: ModelFix[] = fixes.map((s) => ({ ruleKey: s.ruleKey, path: s.path, startLine: s.startLine, endLine: s.line, body: s.body }));
    remediation.handoff.modelFixes = modelFixes;
    remediation.summary += modelFixes.length
      ? ` The fix agent proposed ${modelFixes.length} model-written fix${modelFixes.length === 1 ? '' : 'es'} that Z3 checked (suggestions, not committed).`
      : findings.length && deps.ai.modeFor(repo.workspaceId) === 'cloud'
        ? ' The fix agent found no model-written fix that passed the checks.'
        : '';
  }
  deps.runs.save(run);
  return run;
}
