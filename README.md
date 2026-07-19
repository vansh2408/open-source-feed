# open source feed

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
- `GET|POST /internal/poll`: trigger one polling pass (for external cron pingers).
  Requires `POLL_TRIGGER_TOKEN` via `Authorization: Bearer` header or `?token=`;
  responds `202` immediately and runs the pass in the background, `busy` if one
  is already running

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
| `POLL_TRIGGER_TOKEN` | (unset) | Shared secret enabling `/internal/poll`; endpoint is off when unset |

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
   keeps the UI countdown honest.
3. **GitHub Actions backup**: add Actions secrets `GH_FEED_TOKEN` (your PAT,
   deliberately **not** the auto-injected `GITHUB_TOKEN`, so polling uses your own
   API quota) and `DATABASE_URL`. The workflows then poll every 30 minutes as a
   fallback (covers pinger/host outages via `BACKFILL_HOURS=24`) and enrich every
   6 hours.