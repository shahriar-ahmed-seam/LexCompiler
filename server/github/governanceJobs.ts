import type { JobHandler, JobQueue } from '../jobs/queue.js';
import type { ProductStore, RuleScope } from '../product/store.js';
import type { GitHubApp } from './client.js';
import { enqueueScan } from './webhooks.js';

/**
 * Jobs that talk to GitHub for the governance features. They run in the job queue, so webhook
 * handlers and API requests answer at once and a GitHub hiccup is retried.
 */
export function createGovernanceJobHandlers(deps: { store: ProductStore; getApp: () => GitHubApp | null; queue: () => JobQueue }): Record<string, JobHandler> {
  const app = () => {
    const a = deps.getApp();
    if (!a) throw new Error('the GitHub App is not configured');
    return a;
  };
  return {
    /** Rules changed: re-check every open pull request of the repositories in the rule's scope (the default branch is rescanned by the approval itself). */
    rules_changed: async (p) => {
      const { workspaceId, stamp, scope } = p as { workspaceId: string; stamp: number; scope?: RuleScope };
      for (const repo of scope ? deps.store.reposInScope(workspaceId, scope) : deps.store.listRepos(workspaceId)) {
        if (repo.source !== 'github' || !repo.installationId || !repo.githubRepoId) continue;
        const pulls = await app().request<Array<{ number: number; draft?: boolean; head?: { sha?: string }; base?: { sha?: string } }>>(
          repo.installationId,
          'GET',
          `/repos/${repo.fullName}/pulls?state=open&per_page=50`
        );
        for (const pr of Array.isArray(pulls) ? pulls : []) {
          if (!pr.head?.sha) continue;
          enqueueScan(
            { queue: deps.queue() },
            { githubRepoId: repo.githubRepoId, installationId: repo.installationId, kind: 'pull_request', trigger: 'rerun', headSha: pr.head.sha, baseSha: pr.base?.sha ?? null, prNumber: pr.number },
            `rules:${stamp}:${repo.id}:pr${pr.number}`
          );
        }
      }
    },
  };
}
