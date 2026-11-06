import { readRepositoryFilesAt } from '../analyzer/repoBaseline.js';
import type { EvidenceRecorder } from '../evidence/records.js';
import { lexcompilerVersion } from '../util/versions.js';
import type { TargetRepoFile } from '../../shared/types.js';
import { classifyFindings, scanFilesScoped, type ClassifiedFinding, type RawFinding } from './scanner.js';
import type { ProductStore, Repo, RuleInEffect, ScanRecord, ScanTrigger } from './store.js';
import { scanConclusion, summarizeFindings } from './summary.js';

/**
 * Scans shared by the API, the GitHub job, the MCP tools and the nightly job (product guide,
 * Phase 6): rules limited to their scope, local repository scans, and "Coming up".
 */

/** Rules that apply to a repository, with the path globs each applies to there. */
export function scopedRules(store: ProductStore, repo: Repo, rules: RuleInEffect[]): { rules: RuleInEffect[]; globs: Map<string, string[]> } {
  const globs = new Map<string, string[]>();
  const kept = rules.filter((r) => {
    const g = store.ruleScopeGlobs(r.scope, repo.id);
    globs.set(r.ruleKey, g);
    return g.length > 0;
  });
  return { rules: kept, globs };
}

/** Scans a local repository's folder with the rules in effect, stores the scan and writes its evidence record. */
export async function scanLocalRepo(
  deps: { store: ProductStore; evidence?: EvidenceRecorder },
  repo: Repo,
  trigger: ScanTrigger
): Promise<{ scan: ScanRecord; findings: ClassifiedFinding[]; evidence: { seq: number; headerSha256: string } | null }> {
  const { store } = deps;
  if (!repo.workspaceId || repo.source !== 'local' || !repo.localPath) throw new Error('only local repositories are scanned here');
  const workspaceId = repo.workspaceId;
  const { rules, globs } = scopedRules(store, repo, store.rulesInEffect(workspaceId));
  const scan = store.createScan({ repoId: repo.id, commitSha: 'working-tree', trigger, rules, lexcompilerVersion: lexcompilerVersion() });
  try {
    const files = readRepositoryFilesAt(repo.localPath);
    const result = await scanFilesScoped(files, rules, globs);
    const findings = classifyFindings(result.findings, null, store.activeExceptions(workspaceId, repo.id));
    const summary = summarizeFindings(findings, result.undecidedRuleKeys);
    const done = store.completeScan(scan.id, { conclusion: scanConclusion(summary, false), filesScanned: result.filesScanned, summary, facts: result.facts, findings });
    const evidence = (await deps.evidence?.scanCompleted(workspaceId, { scan: done, rules, findings, undecidedRuleKeys: result.undecidedRuleKeys })) ?? null;
    await storeComingUp(store, repo, 'working-tree', files);
    return { scan: done, findings, evidence: evidence ? { seq: evidence.seq, headerSha256: evidence.headerSha256 } : null };
  } catch (err) {
    store.failScan(scan.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** What each approved, not-yet-effective version finds in these files of the default branch. */
export async function upcomingFindings(store: ProductStore, repo: Repo, files: TargetRepoFile[]): Promise<{ rules: RuleInEffect[]; findings: RawFinding[] }> {
  if (!repo.workspaceId) return { rules: [], findings: [] };
  const { rules, globs } = scopedRules(store, repo, store.upcomingRules(repo.workspaceId));
  if (rules.length === 0) return { rules, findings: [] };
  return { rules, findings: (await scanFilesScoped(files, rules, globs)).findings };
}

/** Recomputes "Coming up" for one repository from its default branch's files. */
export async function storeComingUp(store: ProductStore, repo: Repo, commitSha: string, files: TargetRepoFile[]): Promise<number> {
  const { rules, findings } = await upcomingFindings(store, repo, files);
  for (const r of rules) {
    store.setComingUp({
      workspaceId: repo.workspaceId!,
      repoId: repo.id,
      versionId: r.versionId,
      commitSha,
      findings: findings.filter((f) => f.ruleKey === r.ruleKey).map((f) => ({ filePath: f.filePath, startLine: f.startLine, message: f.message, fingerprint: f.fingerprint })),
    });
  }
  return rules.length;
}

export interface NightlyDeps {
  store: ProductStore;
  evidence?: EvidenceRecorder;
  /** Queues a default-branch scan of a GitHub repository (its job also refreshes "Coming up"). */
  enqueueGithubScan: (repo: Repo, dedupeKey: string) => string | null;
}

/**
 * The nightly job (Phase 6, item 5): scans the default branch of every repository, which catches
 * direct pushes and rules that just took effect, and refreshes "Coming up". Each scan writes an
 * evidence record.
 */
export async function runNightlyScans(deps: NightlyDeps, now: Date = new Date()): Promise<{ local: number; queued: number; failed: string[] }> {
  const day = now.toISOString().slice(0, 10);
  let local = 0;
  let queued = 0;
  const failed: string[] = [];
  for (const ws of deps.store.listWorkspaces()) {
    for (const repo of deps.store.listRepos(ws.id)) {
      try {
        if (repo.source === 'local' && repo.localPath) {
          await scanLocalRepo(deps, repo, 'scheduled');
          local++;
        } else if (repo.githubRepoId !== null && repo.installationId !== null) {
          if (deps.enqueueGithubScan(repo, `nightly:${day}:${repo.id}`)) queued++;
        }
      } catch (err) {
        failed.push(`${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { local, queued, failed };
}
