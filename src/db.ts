import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { IssueRow, PollState } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string): pg.Pool {
  const host = new URL(databaseUrl).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    keepAlive: true,
    ...(isLocal ? {} : { ssl: true }),
  });
  // Neon's pooler drops idle connections; without a listener the resulting
  // 'error' event crashes the process (observed as a crash loop on Render).
  pool.on('error', (err) => {
    console.error('idle db client error (recovering):', err.message);
  });
  return pool;
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    // All migrations are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
    await pool.query(await readFile(path.join(dir, file), 'utf8'));
    console.log(`applied ${file}`);
  }
  // Prove the connection with a trivial query (Phase 0 check).
  const { rows } = await pool.query<{ now: Date }>('SELECT now() AS now');
  console.log(`Migrations applied. DB reachable, server time: ${rows[0]?.now.toISOString()}`);
}

export async function getPollState(pool: pg.Pool, language: string): Promise<PollState | null> {
  const { rows } = await pool.query<PollState>(
    'SELECT language, watermark, last_poll_at, last_poll_count FROM poll_state WHERE language = $1',
    [language]
  );
  return rows[0] ?? null;
}

/** Advance the watermark (never backwards) and record poll stats. */
export async function updatePollState(
  pool: pg.Pool,
  language: string,
  watermark: Date,
  pollCount: number
): Promise<void> {
  await pool.query(
    `INSERT INTO poll_state (language, watermark, last_poll_at, last_poll_count)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (language) DO UPDATE SET
       watermark       = GREATEST(poll_state.watermark, EXCLUDED.watermark),
       last_poll_at    = now(),
       last_poll_count = EXCLUDED.last_poll_count`,
    [language, watermark, pollCount]
  );
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
}

export async function upsertIssues(pool: pg.Pool, issues: IssueRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0 };
  if (issues.length === 0) return counts;

  const client = await pool.connect();
  try {
    for (const issue of issues) {
      const { rows } = await client.query<{ inserted: boolean }>(
        `INSERT INTO issues (id, number, title, url, repo_full_name, repo_stars,
                             language, labels, author_login, comments, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           repo_stars = EXCLUDED.repo_stars,
           labels     = EXCLUDED.labels,
           comments   = EXCLUDED.comments,
           updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS inserted`,
        [
          issue.id,
          issue.number,
          issue.title,
          issue.url,
          issue.repo_full_name,
          issue.repo_stars,
          issue.language,
          issue.labels,
          issue.author_login,
          issue.comments,
          issue.created_at,
          issue.updated_at,
        ]
      );
      if (rows[0]?.inserted) counts.inserted++;
      else counts.updated++;
    }
  } finally {
    client.release();
  }
  return counts;
}

/**
 * Retention: hard-delete rows that no longer belong in a freshness feed:
 * anything retired by enrichment (closed/assigned/deleted upstream) and
 * anything older than the retention window. Safe from re-insertion: the
 * poller only fetches open+unassigned issues created after the watermark.
 */
export async function cleanupIssues(
  pool: pg.Pool,
  retentionDays: number
): Promise<{ retired: number; aged: number }> {
  const retired = await pool.query(`DELETE FROM issues WHERE NOT is_open OR is_assigned`);
  const aged = await pool.query(
    `DELETE FROM issues WHERE created_at < now() - make_interval(days => $1)`,
    [retentionDays]
  );
  return { retired: retired.rowCount ?? 0, aged: aged.rowCount ?? 0 };
}

/** Languages that actually have rows, for the frontend dropdown. */
export async function listLanguages(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ language: string }>(
    'SELECT DISTINCT language FROM issues ORDER BY language'
  );
  return rows.map((r) => r.language);
}

/** Ids of claimable issues due for re-verification, least-recently-checked first. */
export async function selectIssuesToVerify(pool: pg.Pool, limit: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM issues
     WHERE is_open AND NOT is_assigned
     ORDER BY last_verified_at ASC NULLS FIRST, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.id);
}

export interface VerificationUpdate {
  id: string;
  isOpen: boolean;
  isAssigned: boolean;
  comments: number;
}

export async function applyVerification(
  pool: pg.Pool,
  updates: VerificationUpdate[]
): Promise<{ stillClaimable: number; retired: number }> {
  let stillClaimable = 0;
  let retired = 0;
  const client = await pool.connect();
  try {
    for (const u of updates) {
      await client.query(
        `UPDATE issues
         SET is_open = $2, is_assigned = $3, comments = $4, last_verified_at = now()
         WHERE id = $1`,
        [u.id, u.isOpen, u.isAssigned, u.comments]
      );
      if (u.isOpen && !u.isAssigned) stillClaimable++;
      else retired++;
    }
  } finally {
    client.release();
  }
  return { stillClaimable, retired };
}

export interface FeedRow {
  id: string;
  created_at: Date;
  repo_stars: number;
  repo_full_name: string;
  language: string;
  number: number;
  title: string;
  labels: string[];
  author_login: string | null;
  comments: number;
  url: string;
}

export interface FeedQuery {
  limit: number;
  offset?: number;
  minStars?: number;
  maxStars?: number;
  labels?: string[];
  language?: string;
  search?: string;
  sort?: 'newest' | 'stars' | 'stars_asc' | 'comments' | 'comments_asc';
}

export async function readFeed(pool: pg.Pool, query: FeedQuery): Promise<FeedRow[]> {
  // The feed only ever shows still-claimable issues (enrichment flips these).
  const where: string[] = ['is_open', 'NOT is_assigned'];
  const params: unknown[] = [];

  if (query.minStars !== undefined) {
    params.push(query.minStars);
    where.push(`repo_stars >= $${params.length}`);
  }
  if (query.maxStars !== undefined) {
    params.push(query.maxStars);
    where.push(`repo_stars <= $${params.length}`);
  }
  if (query.labels && query.labels.length > 0) {
    // Case-insensitive any-match: GitHub label casing varies ("Bug" vs "bug").
    params.push(query.labels.map((l) => l.toLowerCase()));
    where.push(
      `EXISTS (SELECT 1 FROM unnest(labels) AS l WHERE lower(l) = ANY($${params.length}::text[]))`
    );
  }
  if (query.language) {
    params.push(query.language);
    where.push(`language = $${params.length}`);
  }
  if (query.search) {
    params.push('%' + query.search.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    where.push(`title ILIKE $${params.length}`);
  }

  const ORDER_BY: Record<string, string> = {
    stars: 'repo_stars DESC, created_at DESC',
    stars_asc: 'repo_stars ASC, created_at DESC',
    comments: 'comments DESC, created_at DESC',
    comments_asc: 'comments ASC, created_at DESC',
  };
  const orderBy = ORDER_BY[query.sort ?? ''] ?? 'created_at DESC';

  params.push(query.limit);
  const limitPos = params.length;
  params.push(query.offset ?? 0);
  const offsetPos = params.length;

  const { rows } = await pool.query<FeedRow>(
    `SELECT id, created_at, repo_stars, repo_full_name, language, number, title,
            labels, author_login, comments, url
     FROM issues
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${limitPos} OFFSET $${offsetPos}`,
    params
  );
  return rows;
}
