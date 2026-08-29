import 'dotenv/config';

export interface Config {
  githubToken: string;
  databaseUrl: string;
  starsMin: number;
  pollIntervalSeconds: number;
  backfillHours: number;
  languages: string[];
  labelFilter: string[];
  feedPageSize: number;
  port: number;
  enrichMaxIssues: number;
  retentionDays: number;
  /** Minutes between batched writes to Postgres from the in-memory store. */
  dbFlushMinutes: number;
  /** Minutes between claimability re-verification passes (GitHub only). */
  enrichIntervalMinutes: number;
  /** Minutes between snapshot re-syncs, folded into an existing flush. */
  snapshotReloadMinutes: number;
  /** Shared secret for POST /internal/poll; endpoint is disabled when unset. */
  pollTriggerToken: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `Fatal: required environment variable ${name} is missing or empty. ` +
        `Copy .env.example to .env and fill it in.`
    );
    process.exit(1);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Fatal: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return n;
}

function csvEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(): Config {
  return {
    githubToken: requireEnv('GITHUB_TOKEN'),
    databaseUrl: requireEnv('DATABASE_URL'),
    starsMin: intEnv('STARS_MIN', 100),
    pollIntervalSeconds: intEnv('POLL_INTERVAL_SECONDS', 180),
    backfillHours: intEnv('BACKFILL_HOURS', 24),
    languages: csvEnv('LANGUAGES', ['javascript', 'typescript', 'python', 'go', 'rust', 'java']),
    labelFilter: csvEnv('LABEL_FILTER', []),
    feedPageSize: intEnv('FEED_PAGE_SIZE', 50),
    port: intEnv('PORT', 3000),
    enrichMaxIssues: intEnv('ENRICH_MAX_ISSUES', 500),
    retentionDays: intEnv('RETENTION_DAYS', 2),
    // Neon bills for wall-clock time its compute is awake and autosuspends
    // after five idle minutes, so every write window costs ~5 minutes however
    // small the batch. Writing every 30 minutes instead of every poll is what
    // keeps the monthly compute allowance from being spent by mid-month.
    dbFlushMinutes: intEnv('DB_FLUSH_MINUTES', 30),
    enrichIntervalMinutes: intEnv('ENRICH_INTERVAL_MINUTES', 360),
    snapshotReloadMinutes: intEnv('SNAPSHOT_RELOAD_MINUTES', 360),
    pollTriggerToken: process.env.POLL_TRIGGER_TOKEN?.trim() || null,
  };
}
