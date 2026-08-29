import type pg from 'pg';
import type { Config } from './config.js';
import {
  flushBatch,
  loadClaimableIssues,
  loadPollState,
  type FeedQuery,
  type FeedRow,
  type StoredIssue,
  type UpsertCounts,
} from './db.js';
import { verifyIssueStates } from './github.js';
import type { PollSink } from './poller.js';
import type { IssueRow, PollState } from './types.js';

/**
 * How often the store re-examines its own state. Cheap by design: a tick only
 * touches Postgres when a flush is actually due AND something is buffered.
 */
const TICK_MS = 60_000;

/**
 * Safety valve for a prolonged outage. Ids dropped here are reclaimed by the
 * flush's age-delete once they leave the retention window, so the worst case
 * is a retired row lingering in Postgres (never in the feed, which is served
 * from memory).
 */
const MAX_PENDING_DELETES = 50_000;

const DAY_MS = 86_400_000;

type Comparator = (a: StoredIssue, b: StoredIssue) => number;

const byNewest: Comparator = (a, b) => b.created_at.getTime() - a.created_at.getTime();

/** Mirrors the ORDER BY clauses readFeed builds, tie-breaks included. */
const SORTERS: Record<string, Comparator> = {
  stars: (a, b) => b.repo_stars - a.repo_stars || byNewest(a, b),
  stars_asc: (a, b) => a.repo_stars - b.repo_stars || byNewest(a, b),
  comments: (a, b) => b.comments - a.comments || byNewest(a, b),
  comments_asc: (a, b) => a.comments - b.comments || byNewest(a, b),
};

function toFeedRow(i: StoredIssue): FeedRow {
  return {
    id: i.id,
    created_at: i.created_at,
    repo_stars: i.repo_stars,
    repo_full_name: i.repo_full_name,
    language: i.language,
    number: i.number,
    title: i.title,
    labels: i.labels,
    author_login: i.author_login,
    comments: i.comments,
    url: i.url,
  };
}

/**
 * Authoritative in-memory copy of the claimable feed, with Postgres demoted to
 * a periodic durable checkpoint.
 *
 * Neon bills for wall-clock time its compute is awake, not per query, and it
 * autosuspends only after five idle minutes: a single `SELECT 1` therefore
 * costs the same five minutes as a full write batch. Serving reads from
 * Postgres meant every visitor, every health check and every poll pass held
 * the compute open around the clock. So reads never touch the database, the
 * poller and enrichment mutate this snapshot, and their writes are buffered
 * and committed in one batch per flush interval.
 *
 * Durability rests on one invariant: a language's watermark is persisted only
 * in the same transaction as the issues it covers. Losing the buffer (crash,
 * redeploy, Render spin-down) therefore rewinds nothing - the next boot reads
 * the older watermark and refetches the gap from GitHub, with BACKFILL_HOURS
 * as the backstop.
 *
 * Single-writer by design; correct only while the API runs as one instance.
 */
export class FeedStore implements PollSink {
  private issues = new Map<string, StoredIssue>();
  /** `issues` sorted newest-first, rebuilt lazily after membership changes. */
  private ordered: StoredIssue[] = [];
  private orderDirty = true;

  private watermarks = new Map<string, Date>();
  private lastPollAt: Date | null = null;

  private pendingUpserts = new Map<string, StoredIssue>();
  private pendingDeletes = new Set<string>();
  private pendingWatermarks = new Map<
    string,
    { watermark: Date; count: number; lastPollAt: Date }
  >();

  private lastFlushAt = 0;
  private lastEnrichAt = 0;
  private lastReloadAt = 0;
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config
  ) {}

  // ---- lifecycle ---------------------------------------------------------

  /**
   * One DB wake at boot; after this the request path is pure memory.
   *
   * Never fatal. An unreachable database (Neon suspended, compute allowance
   * spent, network blip) must not stop the service from booting: it comes up
   * with an empty snapshot, the poller refills it from GitHub within one
   * cycle, and the first successful flush persists the lot. Starting empty is
   * safe because a missing watermark falls back to the BACKFILL_HOURS floor,
   * so the poller refetches the window rather than skipping it.
   */
  async hydrate(): Promise<void> {
    let rows: StoredIssue[] = [];
    let state: PollState[] = [];
    try {
      [rows, state] = await Promise.all([
        loadClaimableIssues(this.pool, this.config.retentionDays),
        loadPollState(this.pool),
      ]);
    } catch (err) {
      console.error(
        'store: hydrate failed, starting with an empty snapshot:',
        err instanceof Error ? err.message : err
      );
      const now = Date.now();
      this.issues = new Map();
      this.orderDirty = true;
      this.lastFlushAt = now;
      this.lastEnrichAt = now; // nothing to verify yet; the poller fills first
      this.lastReloadAt = 0; // re-sync at the first flush that succeeds
      return;
    }

    this.issues = new Map(rows.map((r) => [r.id, r]));
    this.orderDirty = true;

    for (const s of state) {
      this.watermarks.set(s.language, s.watermark);
      if (s.last_poll_at && (!this.lastPollAt || s.last_poll_at > this.lastPollAt)) {
        this.lastPollAt = s.last_poll_at;
      }
    }

    const now = Date.now();
    this.lastFlushAt = now;
    this.lastReloadAt = now;
    // Derive the enrichment clock from the data rather than from process
    // start, so restarts neither re-verify everything nor postpone it forever.
    let newestVerification = 0;
    for (const row of this.issues.values()) {
      const at = row.last_verified_at?.getTime() ?? 0;
      if (at > newestVerification) newestVerification = at;
    }
    this.lastEnrichAt = newestVerification;

    console.log(
      `store: hydrated ${this.issues.size} claimable issue(s), ` +
        `${this.watermarks.size} watermark(s); reads now served from memory`
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // The HTTP server owns process liveness; this timer must not extend it.
    this.timer.unref();
  }

  /** Final flush on SIGTERM so a redeploy doesn't strand buffered writes. */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.hasPendingWork()) {
      console.log('store: flushing buffered writes before exit');
      await this.flush();
    }
  }

  private async tick(): Promise<void> {
    try {
      this.pruneAged();

      if (Date.now() - this.lastEnrichAt >= this.config.enrichIntervalMinutes * 60_000) {
        await this.runEnrich();
      }

      if (Date.now() - this.lastFlushAt >= this.config.dbFlushMinutes * 60_000) {
        const flushed = await this.flush();
        // Reload rides on a wake that already happened, never its own.
        if (
          flushed &&
          Date.now() - this.lastReloadAt >= this.config.snapshotReloadMinutes * 60_000
        ) {
          await this.reload();
        }
      }
    } catch (err) {
      console.error('store tick failed:', err instanceof Error ? err.message : err);
    }
  }

  // ---- PollSink: the poller writes here instead of to Postgres -----------

  async watermarkFor(language: string): Promise<Date | null> {
    return this.watermarks.get(language) ?? null;
  }

  async record(
    language: string,
    rows: IssueRow[],
    watermark: Date,
    kept: number
  ): Promise<UpsertCounts> {
    const counts: UpsertCounts = { inserted: 0, updated: 0 };

    for (const row of rows) {
      const existing = this.issues.get(row.id);
      if (existing) {
        // Mirrors the ON CONFLICT DO UPDATE set: refresh what the search
        // re-reports, leave enrichment's verdict alone.
        existing.title = row.title;
        existing.url = row.url;
        existing.repo_stars = row.repo_stars;
        existing.labels = row.labels;
        existing.comments = row.comments;
        existing.updated_at = new Date(row.updated_at);
        this.pendingUpserts.set(row.id, existing);
        counts.updated++;
      } else {
        const fresh: StoredIssue = {
          id: row.id,
          number: row.number,
          title: row.title,
          url: row.url,
          repo_full_name: row.repo_full_name,
          repo_stars: row.repo_stars,
          language: row.language,
          labels: row.labels,
          author_login: row.author_login,
          comments: row.comments,
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at),
          // The search only returns open, unassigned, PR-free issues.
          is_open: true,
          is_assigned: false,
          linked_prs: 0,
          last_verified_at: null,
        };
        this.issues.set(row.id, fresh);
        this.pendingDeletes.delete(row.id);
        this.pendingUpserts.set(row.id, fresh);
        this.orderDirty = true;
        counts.inserted++;
      }
    }

    const polledAt = new Date();
    const previous = this.watermarks.get(language);
    if (!previous || watermark > previous) this.watermarks.set(language, watermark);
    const queued = this.pendingWatermarks.get(language);
    if (!queued || watermark > queued.watermark) {
      this.pendingWatermarks.set(language, { watermark, count: kept, lastPollAt: polledAt });
    }
    this.lastPollAt = polledAt;

    return counts;
  }

  // ---- reads: no database involved ---------------------------------------

  private sorted(): StoredIssue[] {
    if (this.orderDirty) {
      this.ordered = [...this.issues.values()].sort(byNewest);
      this.orderDirty = false;
    }
    return this.ordered;
  }

  /** In-memory equivalent of readFeed, filter and sort semantics included. */
  query(q: FeedQuery): FeedRow[] {
    const wantedLabels =
      q.labels && q.labels.length > 0 ? new Set(q.labels.map((l) => l.toLowerCase())) : null;
    const needle = q.search ? q.search.toLowerCase() : null;
    const comparator = SORTERS[q.sort ?? ''];
    const offset = q.offset ?? 0;
    const ceiling = offset + q.limit;

    const matched: StoredIssue[] = [];
    for (const i of this.sorted()) {
      if (q.minStars !== undefined && i.repo_stars < q.minStars) continue;
      if (q.maxStars !== undefined && i.repo_stars > q.maxStars) continue;
      if (q.language !== undefined && i.language !== q.language) continue;
      if (needle !== null && !i.title.toLowerCase().includes(needle)) continue;
      if (wantedLabels !== null && !i.labels.some((l) => wantedLabels.has(l.toLowerCase()))) {
        continue;
      }
      matched.push(i);
      // Default order is the order we are already walking, so once the page is
      // filled nothing later can displace it.
      if (!comparator && matched.length >= ceiling) break;
    }

    if (comparator) matched.sort(comparator);
    return matched.slice(offset, ceiling).map(toFeedRow);
  }

  status(): {
    lastPollAt: Date | null;
    pollIntervalSeconds: number;
    secondsSinceLastPoll: number | null;
  } {
    const last = this.lastPollAt;
    return {
      lastPollAt: last,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      // Relative age so clients can schedule refreshes immune to their own
      // clock skew (client clocks routinely drift by minutes).
      secondsSinceLastPoll: last
        ? Math.max(0, Math.round((Date.now() - last.getTime()) / 1000))
        : null,
    };
  }

  size(): number {
    return this.issues.size;
  }

  // ---- enrichment and retention, both in memory --------------------------

  /**
   * Re-verify claimability against GitHub. Candidates come from the snapshot
   * rather than a query, and results land in the write buffer, so a full
   * enrichment pass costs zero extra compute windows.
   */
  private async runEnrich(): Promise<void> {
    try {
      const candidates = [...this.issues.values()]
        .sort((a, b) => {
          // last_verified_at ASC NULLS FIRST, then created_at DESC.
          const av = a.last_verified_at?.getTime() ?? -Infinity;
          const bv = b.last_verified_at?.getTime() ?? -Infinity;
          if (av !== bv) return av - bv;
          return byNewest(a, b);
        })
        .slice(0, this.config.enrichMaxIssues);

      if (candidates.length === 0) return;

      const ids = candidates.map((c) => c.id);
      console.log(`enrich: re-verifying ${ids.length} issue(s)`);
      const { statuses, rateLimit } = await verifyIssueStates(this.config.githubToken, ids);

      const verifiedAt = new Date();
      let stillClaimable = 0;
      let retired = 0;

      for (const [id, s] of statuses) {
        const row = this.issues.get(id);
        if (!row) continue;
        if (s.isOpen && !s.isAssigned && s.linkedPrs === 0) {
          row.comments = s.comments;
          row.linked_prs = s.linkedPrs;
          row.last_verified_at = verifiedAt;
          this.pendingUpserts.set(id, row);
          stillClaimable++;
        } else {
          this.issues.delete(id);
          this.pendingUpserts.delete(id);
          this.queueDelete(id);
          this.orderDirty = true;
          retired++;
        }
      }

      console.log(
        `enrich: verified=${statuses.size} stillClaimable=${stillClaimable} ` +
          `retired=${retired} rateLimit.remaining=${rateLimit?.remaining ?? 'n/a'}`
      );
    } catch (err) {
      console.error('enrich pass failed:', err instanceof Error ? err.message : err);
    } finally {
      // Stamped on failure too, so a broken GitHub call cannot turn into a
      // once-a-minute retry loop.
      this.lastEnrichAt = Date.now();
    }
  }

  /**
   * Drop issues past the retention window. Only the snapshot is enumerated:
   * Postgres sheds the same rows via the single age-delete inside flushBatch.
   */
  private pruneAged(): void {
    const cutoff = Date.now() - this.config.retentionDays * DAY_MS;
    let pruned = 0;
    for (const [id, row] of this.issues) {
      if (row.created_at.getTime() < cutoff) {
        this.issues.delete(id);
        this.pendingUpserts.delete(id);
        this.orderDirty = true;
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(
        `store: pruned ${pruned} issue(s) older than ${this.config.retentionDays} day(s)`
      );
    }
  }

  private queueDelete(id: string): void {
    if (this.pendingDeletes.size >= MAX_PENDING_DELETES) {
      const oldest = this.pendingDeletes.values().next().value;
      if (oldest !== undefined) this.pendingDeletes.delete(oldest);
      console.warn('store: pending delete queue full; oldest id dropped (age-delete will reclaim)');
    }
    this.pendingDeletes.add(id);
  }

  // ---- the one write path ------------------------------------------------

  private hasPendingWork(): boolean {
    return (
      this.pendingUpserts.size > 0 ||
      this.pendingDeletes.size > 0 ||
      this.pendingWatermarks.size > 0
    );
  }

  /** Returns whether a batch was actually committed. */
  private async flush(): Promise<boolean> {
    if (this.flushing || !this.hasPendingWork()) return false;
    this.flushing = true;

    // Take ownership of the buffer up front: a poll pass can interleave with
    // the awaits below, and its work belongs to the next batch.
    const upserts = [...this.pendingUpserts.values()];
    const deletes = [...this.pendingDeletes];
    const watermarks = [...this.pendingWatermarks].map(([language, w]) => ({ language, ...w }));
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
    this.pendingWatermarks.clear();

    try {
      const counts = await flushBatch(this.pool, {
        upserts,
        deletes,
        watermarks,
        retentionDays: this.config.retentionDays,
      });
      console.log(
        `flush: upserted=${counts.upserted} deleted=${counts.deleted} ` +
          `aged=${counts.aged} watermarks=${watermarks.length}`
      );
      return true;
    } catch (err) {
      console.error(
        'flush failed, buffer retained for the next interval:',
        err instanceof Error ? err.message : err
      );
      // Put the batch back without clobbering anything newer that arrived
      // while it was in flight. Watermarks stay unpersisted, which is exactly
      // what makes a lost buffer refetchable from GitHub.
      for (const row of upserts) {
        if (!this.pendingUpserts.has(row.id) && this.issues.has(row.id)) {
          this.pendingUpserts.set(row.id, row);
        }
      }
      for (const id of deletes) {
        if (!this.pendingUpserts.has(id)) this.queueDelete(id);
      }
      for (const w of watermarks) {
        const queued = this.pendingWatermarks.get(w.language);
        if (!queued || w.watermark > queued.watermark) {
          this.pendingWatermarks.set(w.language, {
            watermark: w.watermark,
            count: w.count,
            lastPollAt: w.lastPollAt,
          });
        }
      }
      return false;
    } finally {
      // Stamped on both paths: a failing database must not be retried every
      // tick, since each attempt wakes the compute for a full window.
      this.lastFlushAt = Date.now();
      this.flushing = false;
    }
  }

  /**
   * Re-sync the snapshot with Postgres, absorbing any out-of-band writes (the
   * manually dispatched Actions poll). Only ever called straight after a
   * successful flush, so it shares that compute window.
   */
  private async reload(): Promise<void> {
    try {
      const rows = await loadClaimableIssues(this.pool, this.config.retentionDays);
      const next = new Map(rows.map((r) => [r.id, r]));
      // Anything still buffered is newer than what the database just returned.
      for (const [id, row] of this.pendingUpserts) next.set(id, row);
      for (const id of this.pendingDeletes) next.delete(id);
      this.issues = next;
      this.orderDirty = true;
      this.lastReloadAt = Date.now();
      console.log(`store: reloaded snapshot, ${this.issues.size} claimable issue(s)`);
    } catch (err) {
      console.error('snapshot reload failed:', err instanceof Error ? err.message : err);
      this.lastReloadAt = Date.now();
    }
  }
}
