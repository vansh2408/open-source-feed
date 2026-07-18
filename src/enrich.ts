import type pg from 'pg';
import type { Config } from './config.js';
import { applyVerification, cleanupIssues, selectIssuesToVerify } from './db.js';
import { verifyIssueStates } from './github.js';

/**
 * Phase 3 enrichment: re-check open/assigned status of stored claimable
 * issues, least-recently-verified first. Issues found closed, assigned, or
 * deleted are flagged (not deleted) so they drop out of the feed.
 */
export async function enrichOnce(pool: pg.Pool, config: Config): Promise<void> {
  const ids = await selectIssuesToVerify(pool, config.enrichMaxIssues);
  if (ids.length === 0) {
    console.log('enrich: no claimable issues to verify');
  } else {
    console.log(`enrich: re-verifying ${ids.length} issue(s) in batches of 100`);
    const { statuses, rateLimit } = await verifyIssueStates(config.githubToken, ids);

    const updates = [...statuses.entries()].map(([id, s]) => ({
      id,
      isOpen: s.isOpen,
      isAssigned: s.isAssigned,
      comments: s.comments,
    }));
    const { stillClaimable, retired } = await applyVerification(pool, updates);

    console.log(
      `enrich: verified=${updates.length} stillClaimable=${stillClaimable} ` +
        `retired=${retired} rateLimit.remaining=${rateLimit?.remaining ?? 'n/a'}`
    );
  }

  // Retention runs with every enrich pass (every 6h on the cron).
  const { retired: deletedRetired, aged } = await cleanupIssues(pool, config.retentionDays);
  console.log(
    `retention: deleted ${deletedRetired} retired (closed/assigned) and ` +
      `${aged} older than ${config.retentionDays} day(s)`
  );
}