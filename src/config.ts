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
    retentionDays: intEnv('RETENTION_DAYS', 5),
  };
}
