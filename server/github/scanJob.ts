import { emitWorkspaceEvent, scanEventData, type OutboundDeps } from '../events/outbound.js';
import type { JobHandler } from '../jobs/queue.js';
import { storeComingUp, upcomingFindings } from '../product/repoScan.js';
import { classifyFindings, scanFilesScoped, type RawFinding } from '../product/scanner.js';
import type { TargetRepoFile } from '../../shared/types.js';
import { rulesetSha256, type ProductStore, type Repo, type RuleInEffect, type ScanTrigger } from '../product/store.js';
import { summarizeFindings } from '../product/summary.js';
import { lexcompilerVersion } from '../util/versions.js';
import type { EvidenceRecorder } from '../evidence/records.js';
import { CHECK_NAME, checkConclusion, chunk, renderCheckOutput, type CheckKind } from './checkRun.js';
import { GitHubApiError, type GitHubApp } from './client.js';
import { REQUEST_EXCEPTION_ACTION, waiverLine } from './exceptions.js';
import { postSuggestions } from './fixes.js';
import { explainFindings, renderExplanations } from './explanations.js';
import type { AiGateway } from '../ai/gateway.js';
import { readTarballSources } from './tarball.js';

export interface ScanJobPayload {
  githubRepoId: number;
  installationId: number;
  kind: CheckKind;
  trigger: ScanTrigger;
  /** The commit to check. When missing, `ref` (default: the default branch) is resolved first. */
  headSha?: string;
  ref?: string;
  /** Pull requests: the base branch commit GitHub reported. The merge base is used when available. */
  baseSha?: string | null;
  prNumber?: number | null;
}

export interface ScanJobDeps {
  store: ProductStore;
  getApp: () => GitHubApp | null;
  publicUrl: string;
  /** Signs a record of each completed scan; its header hash goes into the check run. */
  evidence?: EvidenceRecorder;
  /** Model calls for AI explanations, after the check is final, when the workspace has AI on (5.5). */
  ai?: AiGateway;
  /** Sends a `scan.completed` event to the workspace's webhook, when it has one. */
  events?: OutboundDeps;
}

interface CommitScan {
  files: TargetRepoFile[];
  findings: RawFinding[];
  undecidedRuleKeys: string[];
  filesScanned: number;
  truncated: boolean;
  facts: unknown;
}

const nowIso = () => new Date().toISOString();

/**
 * Scans one commit for the GitHub App and reports it as a check run. The repository is read
 * from GitHub's archive in memory, parsed, and proved with Z3; nothing in it is executed.
 */
export function createScanJobHandler(deps: ScanJobDeps): JobHandler {
  return async (raw, ctx) => {
    const p = raw as unknown as ScanJobPayload;
    const app = deps.getApp();
    if (!app) throw new Error('the GitHub App is not configured');
    const repo = deps.store.getRepoByGithubId(p.githubRepoId);
    if (!repo) return; // removed from the installation since the job was queued
    const route = `/repos/${repo.fullName}`;
    const installationId = p.installationId;
    const headSha =
      p.headSha ?? (await app.request<{ sha: string }>(installationId, 'GET', `${route}/commits/${encodeURIComponent(p.ref ?? repo.defaultBranch)}`)).sha;

    if (!repo.workspaceId) {
      await app.request(installationId, 'POST', `${route}/check-runs`, {
        name: CHECK_NAME,
        head_sha: headSha,
        status: 'completed',
        conclusion: 'action_required',
        completed_at: nowIso(),
        details_url: `${deps.publicUrl}/github/install`,
        output: {
          title: 'Connect this repository to a LexCompiler workspace',
          summary: `The LexCompiler GitHub App is installed, but this installation is not linked to a workspace, so no rules apply yet. A workspace owner can link it at ${deps.publicUrl}/github/install.`,
        },
      });
      return;
    }

    const globs = new Map<string, string[]>();
    const rules = deps.store.rulesInEffect(repo.workspaceId).filter((r) => {
      const g = deps.store.ruleScopeGlobs(r.scope, repo.id);
      globs.set(r.ruleKey, g);
      return g.length > 0;
    });
    if (rules.length === 0) {
      await app.request(installationId, 'POST', `${route}/check-runs`, {
        name: CHECK_NAME,
        head_sha: headSha,
        status: 'completed',
        conclusion: 'neutral',
        completed_at: nowIso(),
        details_url: deps.publicUrl,
        output: { title: 'No approved rules apply to this repository yet', summary: 'Rules are enforced once someone with the Legal role approves them in LexCompiler.' },
      });
      return;
    }

    const version = lexcompilerVersion();
    const scan = deps.store.createScan({
      repoId: repo.id,
      commitSha: headSha,
      baseSha: p.baseSha ?? null,
      trigger: p.trigger,
      prNumber: p.prNumber ?? null,
      rules,
      lexcompilerVersion: version,
      jobId: ctx.jobId,
    });
    const detailsUrl = `${deps.publicUrl}/app/checks/${scan.id}`;
    let checkRunId: number | null = null;
    let stored = false;
    try {
      const progress = {
        details_url: detailsUrl,
        external_id: scan.id,
        output: { title: `Checking ${rules.length} rules`, summary: `Parsing the code and proving ${rules.map((r) => r.ruleKey).join(', ')} with Z3.` },
      };
      // A retry updates the run its first attempt created (still in progress), so a commit never
      // collects one run per attempt or keeps a run that stays "in progress" forever.
      const reuse = ctx.attempt > 1 ? deps.store.previousCheckRunForJob(ctx.jobId) : null;
      let run: { id: number; html_url?: string } | null = null;
      if (reuse !== null) {
        try {
          await app.request(installationId, 'PATCH', `${route}/check-runs/${reuse}`, { status: 'in_progress', ...progress });
          run = { id: reuse };
        } catch (err) {
          if (!(err instanceof GitHubApiError) || ![404, 422].includes(err.status)) throw err;
        }
      }
      run ??= await app.request<{ id: number; html_url?: string }>(installationId, 'POST', `${route}/check-runs`, {
        name: CHECK_NAME,
        head_sha: headSha,
        status: 'in_progress',
        started_at: nowIso(),
        ...progress,
      });
      checkRunId = run.id;
      deps.store.setScanCheckRun(scan.id, run.id);

      const head = await scanCommit(app, installationId, repo, headSha, rules, globs);
      let base: RawFinding[] | null = null;
      if (p.kind === 'pull_request' && p.baseSha) {
        const baseline = await mergeBase(app, installationId, route, p.baseSha, headSha);
        base = await baselineFindings(deps.store, app, installationId, repo, baseline, rules, globs, version);
      }
      // Approved versions that take effect later: warnings now, and "Coming up" for the default branch.
      const upcoming = await upcomingFindings(deps.store, repo, head.files);
      if (p.kind === 'push') await storeComingUp(deps.store, repo, headSha, head.files);
      const exceptions = deps.store.activeExceptions(repo.workspaceId, repo.id);
      const findings = classifyFindings(head.findings, base, exceptions);
      const summary = summarizeFindings(findings, head.undecidedRuleKeys);
      const conclusion = checkConclusion(p.kind, summary);
      const done = deps.store.completeScan(scan.id, { conclusion, filesScanned: head.filesScanned, summary, facts: head.facts, findings });
      stored = true;
      // The scan is already stored and the check is final; a failure to sign must not fail the run.
      let evidence: { seq: number; headerSha256: string } | null = null;
      try {
        evidence = (await deps.evidence?.scanCompleted(repo.workspaceId, { scan: done, rules, findings, undecidedRuleKeys: head.undecidedRuleKeys, checkRunUrl: run.html_url ?? null })) ?? null;
      } catch (err) {
        console.error(`[evidence] scan ${scan.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Approved exceptions behind waived findings: who approved, until when, and why.
      const waivers: Record<string, { expiresAt: string | null; reason: string; decidedBy: string | null }> = {};
      for (const f of findings) {
        const e = f.exceptionId && !waivers[f.exceptionId] ? deps.store.getException(repo.workspaceId, f.exceptionId) : undefined;
        if (e) waivers[e.id] = { expiresAt: e.expiresAt, reason: e.decisionNote || e.reason, decidedBy: e.decidedByName };
      }

      const output = renderCheckOutput({
        kind: p.kind,
        summary,
        findings,
        rules: rules.map((r) => ({ ruleKey: r.ruleKey, title: r.clause.title, version: r.version })),
        detailsUrl,
        defaultBranch: repo.defaultBranch,
        filesScanned: head.filesScanned,
        truncated: head.truncated,
        lexcompilerVersion: version,
        waiverLine: waiverLine(findings, new Map(exceptions.map((e) => [e.id, e.expiresAt ?? null]))),
        waivers,
        evidence,
        upcoming: upcoming.rules.map((r) => ({ ruleKey: r.ruleKey, version: r.version, effectiveFrom: r.effectiveFrom ?? '', findings: upcoming.findings.filter((f) => f.ruleKey === r.ruleKey) })),
      });
      const [first = [], ...rest] = chunk(output.annotations, 50);
      await app.request(installationId, 'PATCH', `${route}/check-runs/${run.id}`, {
        status: 'completed',
        conclusion,
        completed_at: nowIso(),
        details_url: detailsUrl,
        output: { title: output.title, summary: output.summary, annotations: first },
        // A pull request that fails for new findings offers "Request exception" (check_run.requested_action).
        ...(p.kind === 'pull_request' && summary.newCount > 0 ? { actions: [REQUEST_EXCEPTION_ACTION] } : {}),
      });
      for (const batch of rest) {
        await app.request(installationId, 'PATCH', `${route}/check-runs/${run.id}`, { output: { title: output.title, summary: output.summary, annotations: batch } });
      }
      // The check is final and its scan stored; tell the workspace's webhook (never failing the run).
      if (deps.events) emitWorkspaceEvent(deps.events, repo.workspaceId, 'scan.completed', scanEventData(done, repo, rules, findings, deps.publicUrl));
      // AI explanations (5.5): the result above is final; they only add details to the run.
      let explanations = new Map<string, string>();
      if (p.kind === 'pull_request' && deps.ai && summary.newCount > 0) {
        try {
          const ex = await explainFindings(deps.ai, { workspaceId: repo.workspaceId, findings, rules, files: head.files });
          if (ex.length > 0) {
            await app.request(installationId, 'PATCH', `${route}/check-runs/${run.id}`, { output: { title: output.title, summary: output.summary, text: renderExplanations(ex) } });
            explanations = new Map(ex.map((e) => [e.fingerprint, `**AI explanation** (${e.model}): ${e.text}`]));
          }
        } catch (err) {
          console.warn(`[github] AI explanations on ${repo.fullName} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Suggested changes (Phase 4, item 2): after the check is final, and never failing it.
      if (p.kind === 'pull_request' && p.prNumber) {
        try {
          await postSuggestions(
            { store: deps.store, app },
            { repo, prNumber: p.prNumber, headSha, files: head.files, findings, rules, globs, explanations, ai: deps.ai ? { gateway: deps.ai, workspaceId: repo.workspaceId } : undefined }
          );
        } catch (err) {
          console.warn(`[github] suggestions on ${repo.fullName}#${p.prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!stored) deps.store.failScan(scan.id, message);
      if (checkRunId !== null) {
        // Before the last attempt the run stays in progress (only its text changes); the retry
        // finishes it. After the last attempt it fails, and "Re-run" starts over.
        const retrying = ctx.attempt < ctx.maxAttempts;
        await app
          .request(
            installationId,
            'PATCH',
            `${route}/check-runs/${checkRunId}`,
            retrying
              ? { output: { title: 'Retrying: the last attempt could not finish', summary: `${message.slice(0, 2000)}\n\nLexCompiler retries automatically (attempt ${ctx.attempt} of ${ctx.maxAttempts} failed).` } }
              : {
                  status: 'completed',
                  conclusion: 'failure',
                  completed_at: nowIso(),
                  output: { title: 'LexCompiler could not finish this scan', summary: `${message.slice(0, 2000)}\n\nUse "Re-run" to try again.` },
                }
          )
          .catch(() => undefined);
      }
      throw err;
    }
  };
}

async function scanCommit(
  app: GitHubApp,
  installationId: number,
  repo: Repo,
  sha: string,
  rules: RuleInEffect[],
  globs: Map<string, string[]>
): Promise<CommitScan> {
  const sources = await readTarballSources(await app.downloadTarball(installationId, repo.fullName, sha));
  // A rule scoped to a counterparty is proven only on that counterparty's paths.
  const result = await scanFilesScoped(sources.files, rules, globs);
  return { files: sources.files, findings: result.findings, undecidedRuleKeys: result.undecidedRuleKeys, filesScanned: result.filesScanned, truncated: sources.truncatedAtLimit, facts: result.facts };
}

/** The commit the pull request branched from, so fixes made on the base branch later don't count as new. */
async function mergeBase(app: GitHubApp, installationId: number, route: string, baseSha: string, headSha: string): Promise<string> {
  try {
    const cmp = await app.request<{ merge_base_commit?: { sha?: string } }>(installationId, 'GET', `${route}/compare/${baseSha}...${headSha}`);
    return cmp.merge_base_commit?.sha || baseSha;
  } catch {
    return baseSha;
  }
}

/** Findings on the baseline commit: reused from an earlier scan with the same rules, or scanned now. */
async function baselineFindings(
  store: ProductStore,
  app: GitHubApp,
  installationId: number,
  repo: Repo,
  sha: string,
  rules: RuleInEffect[],
  globs: Map<string, string[]>,
  version: string
): Promise<RawFinding[]> {
  const cached = store.findCompletedScan(repo.id, sha, rulesetSha256(rules));
  if (cached) return store.listFindings(cached.id);
  const scan = store.createScan({ repoId: repo.id, commitSha: sha, trigger: 'baseline', rules, lexcompilerVersion: version });
  try {
    const result = await scanCommit(app, installationId, repo, sha, rules, globs);
    const findings = classifyFindings(result.findings, null, []);
    store.completeScan(scan.id, { conclusion: 'baseline', filesScanned: result.filesScanned, summary: summarizeFindings(findings, result.undecidedRuleKeys), facts: result.facts, findings });
    return result.findings;
  } catch (err) {
    store.failScan(scan.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
