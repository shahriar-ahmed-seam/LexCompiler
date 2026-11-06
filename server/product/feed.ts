import { fetchLiveRegulatoryFeed } from '../compiler/legalCompiler.js';
import { backupDataDir } from '../db/backup.js';
import type { LiveRegulatoryFeedItem } from '../../shared/types.js';
import { runNightlyScans, type NightlyDeps } from './repoScan.js';
import type { ProductStore } from './store.js';
import type { AiGateway } from '../ai/gateway.js';
import { watchRegulationFeed } from './regulationWatch.js';

/**
 * The daily jobs of Phase 6: store new Federal Register and EUR-Lex items, and scan every
 * repository's default branch. Bangladesh Bank circulars have no API; they are uploaded as documents.
 */

/** Fetches the feed and stores the items not seen before; returns how many were new. */
export async function refreshRegulatoryFeed(store: ProductStore, fetchFeed: () => Promise<LiveRegulatoryFeedItem[]> = () => fetchLiveRegulatoryFeed()): Promise<number> {
  const items = await fetchFeed();
  return store.addFeedItems(
    items.map((i) => ({
      id: `${i.source}:${i.documentNumber}`,
      source: i.source,
      documentNumber: i.documentNumber,
      title: i.title,
      publicationDate: i.publicationDate || null,
      agency: i.agencyOrBody || null,
      excerpt: i.excerpt,
      url: i.url || null,
      kind: i.kind ?? 'TEXT',
      illustrative: Boolean(i.illustrative),
    }))
  );
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Runs each daily job when it is due (once a day, kept across restarts in scheduler_runs).
 * Call it on start-up and then hourly.
 */
export async function runDueJobs(
  deps: NightlyDeps & {
    fetchFeed?: () => Promise<LiveRegulatoryFeedItem[]>;
    backup?: { dataDir: string; backupDir: string; keep?: number };
    /** RFC 3161 Time-Stamp Authority for the newest evidence header of each workspace (LEXCOMPILER_TSA_URL). */
    timestamps?: { tsaUrl: string; fetchImpl?: typeof fetch };
    /** Regulation watch after the feed refresh, in workspaces whose AI is on. */
    ai?: AiGateway;
  },
  now: Date = new Date()
): Promise<string[]> {
  const done: string[] = [];
  // The backup runs first, so a failing scan can't skip it (Phase 7: back up data/ daily).
  if (deps.backup && deps.store.claimScheduledRun('backup', DAY, now)) {
    const b = backupDataDir(deps.store.db, deps.backup.dataDir, deps.backup.backupDir, { now, keep: deps.backup.keep });
    done.push(`backup: ${b.files.length} files in ${b.folder}`);
  }
  // After the backup, before the scans: the timestamp covers yesterday's last record (Phase 5).
  if (deps.timestamps && deps.evidence && deps.store.claimScheduledRun('evidence-timestamp', DAY, now)) {
    let stamped = 0;
    const failed: string[] = [];
    for (const ws of deps.store.listWorkspaces()) {
      try {
        if (await deps.evidence.log.timestampLatest(ws.id, deps.timestamps.tsaUrl, deps.timestamps.fetchImpl)) stamped++;
      } catch (err) {
        failed.push(`${ws.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    done.push(`timestamps: ${stamped} headers${failed.length ? `, failed: ${failed.join('; ')}` : ''}`);
  }
  if (deps.store.claimScheduledRun('regulatory-feed', DAY, now)) {
    done.push(`feed: ${await refreshRegulatoryFeed(deps.store, deps.fetchFeed)} new items`);
    if (deps.ai) {
      let summarized = 0;
      for (const ws of deps.store.listWorkspaces()) {
        if (deps.ai.settings(ws.id).mode === 'off') continue;
        try {
          summarized += (await watchRegulationFeed({ store: deps.store, ai: deps.ai }, ws.id)).summarized;
        } catch (err) {
          console.error(`[regulation watch] ${ws.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      done.push(`regulation watch: ${summarized} summaries`);
    }
  }
  if (deps.store.claimScheduledRun('nightly-scans', DAY, now)) {
    const r = await runNightlyScans(deps, now);
    done.push(`nightly scans: ${r.local} local, ${r.queued} queued${r.failed.length ? `, failed: ${r.failed.join('; ')}` : ''}`);
  }
  return done;
}
