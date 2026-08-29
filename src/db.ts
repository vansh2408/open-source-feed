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
    // Neon bills wall-clock time the compute is awake and only autosuspends
    // once it goes quiet, so idle clients must drain promptly rather than
    // linger for the node-postgres default.
    idleTimeoutMillis: 5_000,
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

/**
 * Full persisted shape of an `issues` row, enrichment columns included. The
 * in-memory store (store.ts) holds these; `FeedRow` below is the narrower
 * projection sent to clients.
 */
export interface StoredIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  repo_full_name: string;
  repo_stars: number;
  language: string;
  labels: string[];
  author_login: string | null;
  comments: number;
  created_at: Date;
  updated_at: Date;
  is_open: boolean;
  is_assigned: boolean;
  linked_prs: number;
  last_verified_at: Date | null;
}

// Every write below goes through jsonb_to_recordset rather than a loop of
// single-row statements: one round-trip per batch instead of one per issue.
// Round-trips are what hold the Neon compute open, and `labels` being a
// text[] rules out the usual unnest($1::text[], $2::int[], ...) trick.
const ISSUE_COLS =
  'id, number, title, url, repo_full_name, repo_stars, language, labels, ' +
  'author_login, comments, created_at, updated_at, is_open, is_assigned, ' +
  'linked_prs, last_verified_at';

const ISSUE_RECORD =
  'id text, number integer, title text, url text, repo_full_name text, ' +
  'repo_stars integer, language text, labels text[], author_login text, ' +
  'comments integer, created_at timestamptz, updated_at timestamptz, ' +
  'is_open boolean, is_assigned boolean, linked_prs integer, ' +
  'last_verified_at timestamptz';

/** Columns the poller knows about; enrichment columns keep their defaults. */
const POLL_COLS =
  'id, number, title, url, repo_full_name, repo_stars, language, labels, ' +
  'author_login, comments, created_at, updated_at';

const POLL_RECORD =
  'id text, number integer, title text, url text, repo_full_name text, ' +
  'repo_stars integer, language text, labels text[], author_login text, ' +
  'comments integer, created_at timestamptz, updated_at timestamptz';

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

/**
 * Postgres aborts an ON CONFLICT DO UPDATE whose source rows collide
 * ("cannot affect row a second time"), so a single duplicated id would fail a
 * whole batch. The per-row loop this replaced silently let the last write win;
 * keep that behaviour rather than making callers responsible for it.
 */
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  if (rows.length < 2) return rows;
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.id, row);
  return byId.size === rows.length ? rows : [...byId.values()];
}

/** Batch upsert of freshly polled issues (one round-trip for the whole pass). */
export async function upsertIssues(pool: pg.Pool, issues: IssueRow[]): Promise<UpsertCounts> {
  if (issues.length === 0) return { inserted: 0, updated: 0 };

  const { rows } = await pool.query<{ inserted: boolean }>(
    `INSERT INTO issues (${POLL_COLS})
     SELECT ${POLL_COLS} FROM jsonb_to_recordset($1::jsonb) AS x(${POLL_RECORD})
     ON CONFLICT (id) DO UPDATE SET
       repo_stars = EXCLUDED.repo_stars,
       labels     = EXCLUDED.labels,
       comments   = EXCLUDED.comments,
       updated_at = EXCLUDED.updated_at
     RETURNING (xmax = 0) AS inserted`,
    [JSON.stringify(dedupeById(issues))]
  );

  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, updated: rows.length - inserted };
}

export interface FlushBatch {
  upserts: StoredIssue[];
  deletes: string[];
  /**
   * `lastPollAt` is when the pass actually ran, not when it is being written.
   * Buffering separates the two by up to DB_FLUSH_MINUTES, and stamping now()
   * here would make the poller heartbeat (and the UI countdown it drives) read
   * the flush cadence instead of the poll cadence after a restart.
   */
  watermarks: Array<{ language: string; watermark: Date; count: number; lastPollAt: Date }>;
  retentionDays: number;
}

export interface FlushCounts {
  upserted: number;
  deleted: number;
  aged: number;
}

/**
 * The store's single write path: everything buffered since the last flush,
 * committed in one transaction on one connection. This is the only thing that
 * routinely wakes the Neon compute, so it is deliberately the only place the
 * API process writes.
 */
export async function flushBatch(pool: pg.Pool, batch: FlushBatch): Promise<FlushCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deletes first: an id can be retired and re-polled in the same window,
    // and the insert below must win.
    let deleted = 0;
    if (batch.deletes.length > 0) {
      const res = await client.query('DELETE FROM issues WHERE id = ANY($1::text[])', [
        batch.deletes,
      ]);
      deleted = res.rowCount ?? 0;
    }

    let upserted = 0;
    if (batch.upserts.length > 0) {
      const res = await client.query(
        `INSERT INTO issues (${ISSUE_COLS})
         SELECT ${ISSUE_COLS} FROM jsonb_to_recordset($1::jsonb) AS x(${ISSUE_RECORD})
         ON CONFLICT (id) DO UPDATE SET
           title            = EXCLUDED.title,
           url              = EXCLUDED.url,
           repo_stars       = EXCLUDED.repo_stars,
           labels           = EXCLUDED.labels,
           comments         = EXCLUDED.comments,
           updated_at       = EXCLUDED.updated_at,
           is_open          = EXCLUDED.is_open,
           is_assigned      = EXCLUDED.is_assigned,
           linked_prs       = EXCLUDED.linked_prs,
           last_verified_at = EXCLUDED.last_verified_at`,
        [JSON.stringify(dedupeById(batch.upserts))]
      );
      upserted = res.rowCount ?? 0;
    }

    if (batch.watermarks.length > 0) {
      await client.query(
        `INSERT INTO poll_state (language, watermark, last_poll_at, last_poll_count)
         SELECT language, watermark, last_poll_at, count
         FROM jsonb_to_recordset($1::jsonb)
           AS x(language text, watermark timestamptz, last_poll_at timestamptz, count integer)
         ON CONFLICT (language) DO UPDATE SET
           watermark       = GREATEST(poll_state.watermark, EXCLUDED.watermark),
           last_poll_at    = GREATEST(poll_state.last_poll_at, EXCLUDED.last_poll_at),
           last_poll_count = EXCLUDED.last_poll_count`,
        // jsonb_to_recordset matches columns by key name, so the payload has to
        // speak snake_case; a camelCase key would silently arrive as NULL.
        [
          JSON.stringify(
            batch.watermarks.map((w) => ({
              language: w.language,
              watermark: w.watermark,
              last_poll_at: w.lastPollAt,
              count: w.count,
            }))
          ),
        ]
      );
    }

    // Retention rides along on a wake that already happened, so ageing rows
    // out never costs a compute window of its own.
    const agedRes = await client.query(
      'DELETE FROM issues WHERE created_at < now() - make_interval(days => $1)',
      [batch.retentionDays]
    );

    await client.query('COMMIT');
    return { upserted, deleted, aged: agedRes.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Hydrate the in-memory store: the claimable set still inside the window. */
export async function loadClaimableIssues(
  pool: pg.Pool,
  retentionDays: number
): Promise<StoredIssue[]> {
  const { rows } = await pool.query<StoredIssue>(
    `SELECT ${ISSUE_COLS} FROM issues
     WHERE is_open AND NOT is_assigned AND linked_prs = 0
       AND created_at >= now() - make_interval(days => $1)
     ORDER BY created_at DESC`,
    [retentionDays]
  );
  return rows;
}

/** Hydrate the store's per-language watermarks and poll heartbeat. */
export async function loadPollState(pool: pg.Pool): Promise<PollState[]> {
  const { rows } = await pool.query<PollState>(
    'SELECT language, watermark, last_poll_at, last_poll_count FROM poll_state'
  );
  return rows;
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
  const retired = await pool.query(
    `DELETE FROM issues WHERE NOT is_open OR is_assigned OR linked_prs > 0`
  );
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
     WHERE is_open AND NOT is_assigned AND linked_prs = 0
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
  linkedPrs: number;
}

/** Batch counterpart of the per-issue UPDATE loop this used to run. */
export async function applyVerification(
  pool: pg.Pool,
  updates: VerificationUpdate[]
): Promise<{ stillClaimable: number; retired: number }> {
  let stillClaimable = 0;
  let retired = 0;
  for (const u of updates) {
    if (u.isOpen && !u.isAssigned && u.linkedPrs === 0) stillClaimable++;
    else retired++;
  }
  if (updates.length === 0) return { stillClaimable, retired };

  await pool.query(
    `UPDATE issues AS i SET
       is_open          = v.is_open,
       is_assigned      = v.is_assigned,
       comments         = v.comments,
       linked_prs       = v.linked_prs,
       last_verified_at = now()
     FROM jsonb_to_recordset($1::jsonb)
       AS v(id text, is_open boolean, is_assigned boolean, comments integer, linked_prs integer)
     WHERE i.id = v.id`,
    [
      JSON.stringify(
        updates.map((u) => ({
          id: u.id,
          is_open: u.isOpen,
          is_assigned: u.isAssigned,
          comments: u.comments,
          linked_prs: u.linkedPrs,
        }))
      ),
    ]
  );
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

/**
 * Direct read of the feed from Postgres. The API no longer uses this (it
 * answers from the in-memory store); it remains for the `feed` CLI command
 * and any out-of-band tooling.
 */
export async function readFeed(pool: pg.Pool, query: FeedQuery): Promise<FeedRow[]> {
  // The feed only ever shows still-claimable issues (enrichment flips these).
  const where: string[] = ['is_open', 'NOT is_assigned', 'linked_prs = 0'];
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
