# open source feed

**Live at [opensourcefeed.dev](https://opensourcefeed.dev)**

A live feed of **fresh, open, unassigned** issues from popular open-source repositories,
surfaced minutes after they're opened, and removed the moment they're claimed.

Covers JavaScript, TypeScript, Python, Go, Rust and Java repos with **100★+** by default
(both configurable). Built for developers who want to contribute but keep finding issues
that are already taken.

## How it works

| Cadence | Job | What it does |
|---|---|---|
| every 5 min | `pollOnce` (external pinger hits `/internal/poll`) | Fetches issues created since the last check per language, filters by stars/archived client-side, and records them in the **in-memory store**. A per-language watermark keeps steady-state polls tiny. Readers see new issues immediately; Postgres does not. |
| every 30 min | store flush | Everything buffered since the last flush — upserts, retirements, watermarks, retention — committed to Postgres in **one transaction on one connection**. This is the only routine database write. |
| every 6 h | enrichment (in-process) | Re-verifies stored issues against GitHub: anything closed, assigned, or PR-linked drops out of the feed; comment counts refresh. Candidates come from memory and results ride the next flush, so a full pass costs no extra database time. |
| on next poll | frontend | The page re-checks just after a poll pass should have landed and reveals an "N new issues" pill. Reads are served from memory. |

Key design point: the GitHub issue search never sees a star filter (`stars:` is invalid for
issue search). Star counts come back as a field per result and are filtered in our code:
`src/github.ts` has a runtime guard that throws if `stars:` ever enters a query.

### Why reads never touch Postgres

Neon bills for **wall-clock time the compute is awake**, not per query, and it autosuspends
after 5 idle minutes. One `SELECT 1` therefore costs the same 5-minute window as a full write
batch. On the free tier, 100 CU-hrs ÷ 0.25 CU = 400 awake-hours/month, i.e. the database may
be awake at most ~54% of the time.

Serving the feed from Postgres blew straight through that: a `SELECT 1` in `/health` (probed
continuously by Render) pinned the compute awake on its own, at ~182 CU-hrs/month. So
`src/store.ts` holds the claimable feed in memory as the runtime source of truth, and
Postgres is demoted to a periodic durable checkpoint.

Durability rests on one invariant: **a language's watermark is persisted only in the same
transaction as the issues it covers.** Losing the buffer to a crash, redeploy or spin-down
rewinds nothing — the next boot reads the older watermark and refetches the gap from GitHub,
with `BACKFILL_HOURS` as the backstop.

This makes the API single-writer, and correct only while it runs as **one instance**.

A useful side effect: the site no longer depends on the database being up. `npm start`
(`serve`) warns and continues if migrations fail, `hydrate` starts with an empty snapshot if
Postgres is unreachable, and a failed flush retains its buffer for the next interval. A dead
database costs freshness of the persisted copy, not availability — the poller refills memory
from GitHub within one cycle and the first successful flush catches everything up.

Rate budget: a full 6-language poll costs roughly 6 to 60 points of GitHub's 5,000/hour GraphQL
allowance. `rateLimit` is checked on every request with backoff below a safety buffer,
and `Retry-After` is honored on 403/429.

## Stack

Node.js + TypeScript (strict), raw SQL via `pg` against NeonDB (serverless Postgres,
pooled connection string), plain `fetch` for the GitHub GraphQL API, `fastify` for the
read API, and a single static HTML page for the frontend. No framework, no build step.
Runtime dependencies: `pg`, `dotenv`, `fastify`.

## Setup

```sh
npm install
cp .env.example .env    # fill in GITHUB_TOKEN (classic PAT, NO scopes needed)
                        # and DATABASE_URL (Neon POOLED string, host has -pooler)
npm run migrate         # applies migrations/, proves DB connectivity
npm run poll:once       # first pass, backfills the last BACKFILL_HOURS
npm run api             # open http://localhost:3000
```

## Commands

| Script | What it does |
|---|---|
| `npm run migrate` | Apply all migrations (idempotent) |
| `npm run poll:once [-- lang]` | One polling pass over all configured languages (or one) |
| `npm run poll:watch` | Loop forever, `POLL_INTERVAL_SECONDS` between passes |
| `npm run enrich` | Re-verify claimability + retention cleanup |
| `npm run api` | Serve frontend + JSON API (`npm run dev` = with reload) |
| `npm run feed [-- N]` | Print the latest N issues to the terminal |
| `npm run typecheck` | `tsc --noEmit` |

## HTTP surface

- `GET /`: the feed UI (filters, search, sort, bookmarks, NEW-since-last-visit)
- `GET /about`: product page
- `GET /issues`: JSON feed of claimable issues. Params: `limit` (≤200), `offset`,
  `min_stars`, `labels` (CSV, any-match, case-insensitive), `language`, `q` (title
  search), `sort` (`stars` | `comments`, default newest)
- `GET /feed.xml`: Atom feed; accepts the same params, so filtered subscriptions work
- `GET /languages`: distinct languages present (drives the UI dropdown)
- `GET /status`: poller heartbeat (`lastPollAt`), drives the UI sync countdown
- `GET /health`: process liveness and the in-memory issue count. **Deliberately does not
  touch Postgres** — Render probes it continuously, and a `SELECT 1` here was on its own
  enough to hold the Neon compute awake around the clock
- `GET /internal/health/db`: token-gated manual connectivity probe. Never wire this into an
  automated health check; calling it costs a compute window
- `GET|POST /internal/poll`: trigger one polling pass (for external cron pingers).
  Requires `POLL_TRIGGER_TOKEN` via `Authorization: Bearer` header or `?token=`;
  responds `202` immediately and runs the pass in the background, `busy` if one
  is already running

Every read above is answered from memory. `/issues` and `/feed.xml` also send a short
`cache-control`, so repeat crawls and multi-tab readers need not even reach the origin.

## Configuration

All via env (see `.env.example`); validated at startup, fails fast when required vars
are missing.

| Var | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` | (required) | Classic PAT, no scopes (public data only) |
| `DATABASE_URL` | (required) | Neon **pooled** connection string |
| `STARS_MIN` | 100 | Client-side star floor at ingestion |
| `LANGUAGES` | js,ts,python,go,rust,java | One search pass per language |
| `BACKFILL_HOURS` | 24 | Cold-start lookback window |
| `POLL_INTERVAL_SECONDS` | 180 | `poll:watch` spacing; also drives the UI countdown |
| `LABEL_FILTER` | (empty) | Optional CSV; one query pass per label |
| `RETENTION_DAYS` | 2 | Issues older than this leave the feed. Small enough that one enrich pass re-verifies the whole set, so "verified claimable" stays literally true |
| `ENRICH_MAX_ISSUES` | 500 | Re-verifications per enrich pass |
| `FEED_PAGE_SIZE` | 50 | Default API page size |
| `PORT` | 3000 | API port |
| `POLL_TRIGGER_TOKEN` | (unset) | Shared secret enabling `/internal/poll`; endpoint is off when unset |
| `DB_FLUSH_MINUTES` | 30 | Minutes between batched writes to Postgres. **The main cost dial**: each flush wakes the Neon compute for ~5 minutes regardless of batch size, so 30 min ≈ 32 CU-hrs/month and 60 min ≈ 16, against a 100 CU-hr free allowance |
| `ENRICH_INTERVAL_MINUTES` | 360 | Claimability re-verification. Calls GitHub only; results ride the next flush, so this costs no database time |
| `SNAPSHOT_RELOAD_MINUTES` | 360 | Re-sync memory from Postgres, absorbing out-of-band writes. Only ever runs straight after a successful flush, so it shares that compute window |

## Deploying

The whole app (frontend + API + Atom feed) is one Node service, deployed free on
Render with an external pinger driving the poll cadence.

1. **Render**: [New → Blueprint](https://dashboard.render.com/select-repo?type=blueprint),
   pick this repo — `render.yaml` defines the free web service (build `npm ci`,
   start `npm start` = migrate then serve). Set the two secrets it prompts for:
   `GITHUB_TOKEN` (classic PAT, no scopes) and `DATABASE_URL` (Neon pooled).
   `POLL_TRIGGER_TOKEN` is generated automatically.
2. **Pinger**: on [cron-job.org](https://cron-job.org) (free), create a job hitting
   `https://<service>.onrender.com/internal/poll` every 5 minutes with header
   `Authorization: Bearer <POLL_TRIGGER_TOKEN>` (copy the generated value from the
   Render dashboard). This one ping both triggers a polling pass and keeps the
   free-tier service from sleeping. `POLL_INTERVAL_SECONDS=300` in `render.yaml`
   keeps the UI countdown honest. Polling this often is cheap now: a pass writes to
   memory, and only the 30-minute flush reaches Postgres.
3. **GitHub Actions backup**: add Actions secrets `GH_FEED_TOKEN` (your PAT,
   deliberately **not** the auto-injected `GITHUB_TOKEN`, so polling uses your own
   API quota) and `DATABASE_URL`. `poll.yml` runs once daily as a floor that keeps
   the table populated through a multi-day Render outage; `enrich.yml` is
   `workflow_dispatch` only, since enrichment now runs in-process. Both write
   straight through to Postgres, so **do not put either back on a frequent
   schedule** — at `*/30`, `poll.yml` alone cost ~31 CU-hrs/month.
4. **Neon**: check *Branch → Compute → Edit → Scale to zero*. The default 5-minute
   delay is a multiplier on every single wake; if your plan allows 1 minute, the
   whole workload gets ~5× cheaper.