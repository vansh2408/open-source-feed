import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import type { FeedQuery } from './db.js';
import { pollOnce } from './poller.js';
import { llmsTxt, renderAppPage, robotsTxt, sitemapXml } from './seo.js';
import { FeedStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const ABOUT_HTML = path.join(__dirname, '..', 'public', 'about.html');
const GUIDE_HTML = path.join(__dirname, '..', 'public', 'guide.html');
const OG_PNG = path.join(__dirname, '..', 'public', 'og.png');

/** Issues server-rendered into the HTML shell for crawlers (JS re-renders). */
const SSR_ISSUE_COUNT = 30;

const MAX_PAGE_SIZE = 200;
// Star/offset params compare against Postgres integer columns; anything
// larger than int4 max would make the query itself error.
const INT4_MAX = 2_147_483_647;

function intParam(value: unknown, fallback: number, max?: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  // Number, not parseInt: parseInt truncates exponent notation ("1e9" -> 1).
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

/** Shared by /issues and /feed.xml so both take the same filter params. */
function parseFeedQuery(rawQ: Record<string, unknown>, config: Config): FeedQuery {
  // Fastify parses repeated keys (?labels=a&labels=b) as arrays; normalize to
  // strings so nothing below throws or leaks an array into a SQL param.
  const q: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(rawQ)) {
    if (Array.isArray(v)) q[k] = k === 'labels' ? v.join(',') : String(v[v.length - 1]);
    else if (typeof v === 'string') q[k] = v;
  }

  const labels = q.labels
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const SORTS = ['stars', 'stars_asc', 'comments', 'comments_asc'] as const;
  const sort = SORTS.find((s) => s === q.sort);

  return {
    limit: intParam(q.limit, config.feedPageSize, MAX_PAGE_SIZE),
    offset: intParam(q.offset, 0, INT4_MAX),
    ...(q.min_stars !== undefined ? { minStars: intParam(q.min_stars, 0, INT4_MAX) } : {}),
    ...(q.max_stars !== undefined ? { maxStars: intParam(q.max_stars, INT4_MAX, INT4_MAX) } : {}),
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

/**
 * Lean read API + static frontend + Atom feed.
 *
 * Nothing on the request path touches Postgres. Every read is answered from
 * the in-memory store (see store.ts), which is hydrated once at boot and kept
 * current by the poller; the database is woken only by the store's periodic
 * batched flush. Serving reads from Postgres is what exhausted Neon's monthly
 * compute allowance, because each query keeps the compute billable for a full
 * five-minute autosuspend window regardless of how trivial it is.
 */
export async function startApi(pool: pg.Pool, config: Config): Promise<void> {
  const store = new FeedStore(pool, config);
  await store.hydrate();
  store.start();

  // trustProxy: behind Render's proxy the client IP arrives in
  // x-forwarded-for; without this the rate limiter would bucket every
  // visitor under the proxy's IP.
  const app = Fastify({ logger: false, trustProxy: true });

  // Per-IP limit, in-memory (single instance). Generous enough for a human
  // plus an aggressive feed reader.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health', // Render's own health checks
  });

  const tokenAuthorized = (req: FastifyRequest): boolean => {
    if (!config.pollTriggerToken) return false;
    const auth = req.headers.authorization;
    const presented = auth?.startsWith('Bearer ')
      ? auth.slice('Bearer '.length)
      : (req.query as Record<string, string | undefined>).token;
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(config.pollTriggerToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // The app shell is served with the first page of issues rendered into it:
  // crawlers (and AI bots, which mostly don't run JS) see real content; the
  // client script re-renders over it on load.
  const ssrIssues = (language?: string) =>
    store.query({ limit: SSR_ISSUE_COUNT, ...(language ? { language } : {}) });

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    const template = await readFile(INDEX_HTML, 'utf8');
    return renderAppPage(template, ssrIssues());
  });

  // Language landing pages (/python, /rust, ...): same app, preset filter,
  // own title/description/canonical. Only configured languages resolve.
  app.get('/:lang', async (req, reply) => {
    const { lang } = req.params as { lang: string };
    if (!config.languages.includes(lang)) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    const template = await readFile(INDEX_HTML, 'utf8');
    return renderAppPage(template, ssrIssues(lang), { lang });
  });

  app.get('/about', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return readFile(ABOUT_HTML, 'utf8');
  });

  app.get('/guide', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return readFile(GUIDE_HTML, 'utf8');
  });

  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600');
    return robotsTxt();
  });

  app.get('/sitemap.xml', async (_req, reply) => {
    reply.type('application/xml; charset=utf-8').header('cache-control', 'public, max-age=3600');
    return sitemapXml(config.languages);
  });

  app.get('/llms.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600');
    return llmsTxt(config.languages);
  });

  // Social-preview card (og:image target for link unfurls).
  app.get('/og.png', async (_req, reply) => {
    reply.type('image/png').header('cache-control', 'public, max-age=86400');
    return readFile(OG_PNG);
  });

  // Liveness only, and deliberately database-free: Render probes this
  // continuously, and a `SELECT 1` here was on its own enough to hold the Neon
  // compute awake around the clock (~182 CU-hrs/month against a 100 CU-hr
  // allowance). Feed staleness is visible via /status instead.
  app.get('/health', async () => ({ ok: true, issues: store.size() }));

  // Manual connectivity probe. Token-gated and never wired into any automated
  // check, precisely because calling it costs a compute window.
  app.get('/internal/health/db', async (req, reply) => {
    if (!tokenAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // External-cron poll trigger (e.g. cron-job.org every 5 min). The ping also
  // keeps a free-tier host awake. Responds 202 immediately; the pass runs in
  // the background because a full multi-language pass outlives pinger timeouts.
  // Results land in the in-memory store, not Postgres: they reach the database
  // on the store's next batched flush.
  let pollRunning = false;
  let lastPoll: { startedAt: string; ok: boolean; inserted?: number; error?: string } | null = null;

  const triggerPoll = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.pollTriggerToken) {
      return reply.code(503).send({ error: 'POLL_TRIGGER_TOKEN not configured' });
    }
    if (!tokenAuthorized(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (pollRunning) {
      return reply.code(200).send({ status: 'busy', lastPoll });
    }
    pollRunning = true;
    const startedAt = new Date().toISOString();
    void pollOnce(store, config)
      .then((results) => {
        const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
        lastPoll = { startedAt, ok: true, inserted };
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        lastPoll = { startedAt, ok: false, error: message.slice(0, 200) };
        console.error('triggered poll pass failed:', lastPoll.error);
      })
      .finally(() => {
        pollRunning = false;
      });
    return reply.code(202).send({ status: 'started', lastPoll });
  };

  // GET as well as POST: some free pingers (UptimeRobot) can only send GET.
  app.post('/internal/poll', triggerPoll);
  app.get('/internal/poll', triggerPoll);

  app.get('/languages', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return { languages: store.languages() };
  });

  // Poller heartbeat: drives the "next sync" countdown in the UI.
  app.get('/status', async () => store.status());

  // GET /issues?limit=50&offset=0&min_stars=500&labels=bug,help%20wanted&language=typescript
  app.get('/issues', async (req, reply) => {
    // Kept well under POLL_INTERVAL_SECONDS: the frontend's background check
    // fires ~45s after a pass should have landed, and a longer window could
    // serve it a response cached from just before the pass, under-reporting the
    // "N new issues" pill for a whole cycle. This only saves Render CPU on
    // repeat crawls - reads cost no database time either way.
    reply.header('cache-control', 'public, max-age=30');
    const issues = store.query(parseFeedQuery(req.query as Record<string, unknown>, config));
    return { count: issues.length, issues };
  });

  // Atom feed; accepts the same filter params as /issues, so subscribers can
  // follow e.g. /feed.xml?language=rust&labels=good%20first%20issue
  app.get('/feed.xml', async (req, reply) => {
    const issues = store.query(parseFeedQuery(req.query as Record<string, unknown>, config));

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

    reply
      .type('application/atom+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=300');
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>open source feed: fresh, unassigned, claimable issues</title>
  <subtitle>New contribution-ready issues from 100★+ repos, minutes after they open.</subtitle>
  <id>${xmlEscape(`${base}/feed.xml`)}</id>
  <link href="${xmlEscape(selfUrl)}" rel="self"/>
  <link href="${xmlEscape(`${base}/`)}"/>
  <updated>${updated}</updated>
${entries}
</feed>`;
  });

  // Render sends SIGTERM before replacing an instance; flush first so a
  // redeploy never strands the write buffer.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: draining`);
    try {
      await app.close();
      await store.shutdown();
      await pool.end();
    } catch (err) {
      console.error('shutdown error:', err instanceof Error ? err.message : err);
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  const address = await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`API listening on ${address}  (GET /, /issues, /feed.xml, /languages, /health)`);
  console.log(
    `store: flushing to Postgres every ${config.dbFlushMinutes}m, ` +
      `enriching every ${config.enrichIntervalMinutes}m, ` +
      `retention ${config.retentionDays}d`
  );
}
