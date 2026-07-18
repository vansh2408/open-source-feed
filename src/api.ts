import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { listLanguages, readFeed, type FeedQuery } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const ABOUT_HTML = path.join(__dirname, '..', 'public', 'about.html');

const MAX_PAGE_SIZE = 200;

function intParam(value: unknown, fallback: number, max?: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

/** Shared by /issues and /feed.xml so both take the same filter params. */
function parseFeedQuery(q: Record<string, string | undefined>, config: Config): FeedQuery {
  const labels = q.labels
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sort = q.sort === 'stars' || q.sort === 'comments' ? q.sort : undefined;

  return {
    limit: intParam(q.limit, config.feedPageSize, MAX_PAGE_SIZE),
    offset: intParam(q.offset, 0),
    ...(q.min_stars !== undefined ? { minStars: intParam(q.min_stars, 0) } : {}),
    ...(labels && labels.length > 0 ? { labels } : {}),
    ...(q.language ? { language: q.language } : {}),
    ...(q.q?.trim() ? { search: q.q.trim() } : {}),
    ...(sort ? { sort } : {}),
  };
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      default: return '&quot;';
    }
  });
}

/** Lean read API + static frontend + Atom feed. */
export async function startApi(pool: pg.Pool, config: Config): Promise<void> {
  const app = Fastify({ logger: false });

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return readFile(INDEX_HTML, 'utf8');
  });

  app.get('/about', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return readFile(ABOUT_HTML, 'utf8');
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.get('/languages', async () => {
    return { languages: await listLanguages(pool) };
  });

  // Poller heartbeat: drives the "next sync" countdown in the UI.
  app.get('/status', async () => {
    const { rows } = await pool.query<{ last_poll_at: Date | null }>(
      'SELECT max(last_poll_at) AS last_poll_at FROM poll_state'
    );
    return {
      lastPollAt: rows[0]?.last_poll_at ?? null,
      pollIntervalSeconds: config.pollIntervalSeconds,
    };
  });

  // GET /issues?limit=50&offset=0&min_stars=500&labels=bug,help%20wanted&language=typescript
  app.get('/issues', async (req) => {
    const issues = await readFeed(
      pool,
      parseFeedQuery(req.query as Record<string, string | undefined>, config)
    );
    return { count: issues.length, issues };
  });

  // Atom feed; accepts the same filter params as /issues, so subscribers can
  // follow e.g. /feed.xml?language=rust&labels=good%20first%20issue
  app.get('/feed.xml', async (req, reply) => {
    const issues = await readFeed(
      pool,
      parseFeedQuery(req.query as Record<string, string | undefined>, config)
    );

    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const host = req.headers.host ?? `localhost:${config.port}`;
    const base = `${proto}://${host}`;
    const selfUrl = `${base}${req.url}`;
    const updated = (issues[0]?.created_at ?? new Date()).toISOString();

    const entries = issues
      .map(
        (i) => `  <entry>
    <id>${xmlEscape(i.url)}</id>
    <title>${xmlEscape(`★${i.repo_stars} ${i.repo_full_name}#${i.number}: ${i.title}`)}</title>
    <link href="${xmlEscape(i.url)}"/>
    <updated>${i.created_at.toISOString()}</updated>
    <author><name>${xmlEscape(i.author_login ?? 'unknown')}</name></author>
    <summary>${xmlEscape(
      `${i.language} · ★${i.repo_stars} · ${i.comments} comment(s) · labels: ${i.labels.join(', ') || 'none'}`
    )}</summary>
  </entry>`
      )
      .join('\n');

    reply.type('application/atom+xml; charset=utf-8');
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>issuefeed: fresh, unassigned, claimable open-source issues</title>
  <subtitle>New contribution-ready issues from 100★+ repos, minutes after they open.</subtitle>
  <id>${xmlEscape(`${base}/feed.xml`)}</id>
  <link href="${xmlEscape(selfUrl)}" rel="self"/>
  <link href="${xmlEscape(`${base}/`)}"/>
  <updated>${updated}</updated>
${entries}
</feed>`;
  });

  const address = await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`API listening on ${address}  (GET /, /issues, /feed.xml, /languages, /health)`);
}