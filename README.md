# issuefeed

A live feed of **fresh, open, unassigned** issues from popular open-source repositories,
surfaced minutes after they're opened, and removed the moment they're claimed.

Covers JavaScript, TypeScript, Python, Go, Rust and Java repos with **100★+** by default
(both configurable). Built for developers who want to contribute but keep finding issues
that are already taken.

## How it works

| Cadence | Job | What it does |
|---|---|---|
| every 5 min | `poll:once` (GitHub Actions cron) | Fetches issues created since the last check per language, filters by stars/archived client-side, upserts into Postgres. A per-language watermark keeps steady-state polls tiny. |
| every 6 h | `enrich` (GitHub Actions cron) | Re-verifies stored issues against GitHub: anything closed, assigned, or deleted is flagged out of the feed; comment counts refresh. Then retention deletes retired rows and anything older than `RETENTION_DAYS`. |
| every 60 s | frontend | The page re-reads the local database. Never touches GitHub. |

Key design point: the GitHub issue search never sees a star filter (`stars:` is invalid for
issue search). Star counts come back as a field per result and are filtered in our code:
`src/github.ts` has a runtime guard that throws if `stars:` ever enters a query.

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
- `GET /health`: DB liveness

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
| `RETENTION_DAYS` | 5 | Issues older than this are deleted |
| `ENRICH_MAX_ISSUES` | 500 | Re-verifications per enrich run |
| `FEED_PAGE_SIZE` | 50 | Default API page size |
| `PORT` | 3000 | API port |

## Deploying

1. Push this repo to GitHub.
2. Add two Actions secrets: `GH_FEED_TOKEN` (your PAT, deliberately **not** the
   auto-injected `GITHUB_TOKEN`, so polling uses your own API quota) and `DATABASE_URL`.
   The workflows in `.github/workflows/` then poll every 5 minutes and enrich every 6
   hours with zero infrastructure.
3. Host the API anywhere always-on (Fly.io / Railway / Render hobby tier) with the same
   two env vars plus `POLL_INTERVAL_SECONDS=300` so the UI countdown matches the cron.