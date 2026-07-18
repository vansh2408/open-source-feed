import type pg from 'pg';
import type { Config } from './config.js';
import { getPollState, updatePollState, upsertIssues } from './db.js';
import { filterIssues, labelNames } from './filter.js';
import { buildSearchQuery, searchAllIssues, sleep, toSearchIso } from './github.js';
import type { IssueNode, IssueRow, PollResult } from './types.js';

/** Pause between search passes (labels/languages) for the secondary limit. */
const INTER_PASS_DELAY_MS = 2000;

function toRow(issue: IssueNode, language: string): IssueRow {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    repo_full_name: issue.repository.nameWithOwner,
    repo_stars: issue.repository.stargazerCount,
    language,
    labels: labelNames(issue),
    author_login: issue.author?.login ?? null,
    comments: issue.comments.totalCount,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * One polling pass for one language (§5). When LABEL_FILTER is set, runs one
 * search per label (§6: one label per query) against the same watermark and
 * merges results by node id before upserting.
 */
export async function pollLanguage(
  pool: pg.Pool,
  config: Config,
  language: string
): Promise<PollResult> {
  const state = await getPollState(pool, language);
  const floor = new Date(Date.now() - config.backfillHours * 3600_000);
  const since = state ? state.watermark : floor;
  const sinceIso = toSearchIso(since);

  console.log(`[${language}] polling since ${sinceIso}${state ? '' : ' (cold start floor)'}`);

  // One pass with no label narrowing, or one pass per configured label.
  const labelPasses: Array<string | null> =
    config.labelFilter.length > 0 ? config.labelFilter : [null];

  const byId = new Map<string, IssueNode>();
  let rateLimitRemaining: number | null = null;

  for (const [i, label] of labelPasses.entries()) {
    const q = buildSearchQuery(language, sinceIso, label ?? undefined);
    console.log(`[${language}] query: ${q}`);
    const { issues, rateLimit } = await searchAllIssues(config.githubToken, q);
    for (const issue of issues) byId.set(issue.id, issue);
    rateLimitRemaining = rateLimit?.remaining ?? rateLimitRemaining;
    if (i < labelPasses.length - 1) await sleep(INTER_PASS_DELAY_MS);
  }

  const fetched = [...byId.values()];

  // Watermark advances by the max createdAt over ALL fetched nodes, not just
  // survivors: otherwise below-threshold issues would be refetched forever.
  let maxCreated = since;
  for (const issue of fetched) {
    const created = new Date(issue.createdAt);
    if (created > maxCreated) maxCreated = created;
  }

  const kept = filterIssues(fetched, config);
  const { inserted, updated } = await upsertIssues(
    pool,
    kept.map((issue) => toRow(issue, language))
  );

  await updatePollState(pool, language, maxCreated, kept.length);

  const result: PollResult = {
    language,
    fetched: fetched.length,
    kept: kept.length,
    inserted,
    updated,
    watermark: toSearchIso(maxCreated),
    rateLimitRemaining,
  };
  console.log(
    `[${language}] fetched=${result.fetched} kept=${result.kept} ` +
      `inserted=${result.inserted} updated=${result.updated} ` +
      `watermark=${result.watermark} rateLimit.remaining=${result.rateLimitRemaining}`
  );
  return result;
}

/** Single pass over every configured language, then exits (poll:once). */
export async function pollOnce(
  pool: pg.Pool,
  config: Config,
  languages: string[] = config.languages
): Promise<PollResult[]> {
  const results: PollResult[] = [];
  for (const [i, language] of languages.entries()) {
    results.push(await pollLanguage(pool, config, language));
    if (i < languages.length - 1) await sleep(INTER_PASS_DELAY_MS);
  }
  const totals = results.reduce(
    (acc, r) => ({ inserted: acc.inserted + r.inserted, kept: acc.kept + r.kept }),
    { inserted: 0, kept: 0 }
  );
  console.log(`pass complete: kept=${totals.kept} inserted=${totals.inserted} across ${results.length} language(s)`);
  return results;
}

/** Loop forever with POLL_INTERVAL_SECONDS between passes (poll:watch). */
export async function pollWatch(pool: pg.Pool, config: Config): Promise<never> {
  console.log(`poll:watch started (interval ${config.pollIntervalSeconds}s, languages: ${config.languages.join(', ')})`);
  for (;;) {
    try {
      await pollOnce(pool, config);
    } catch (err) {
      console.error('poll pass failed:', err instanceof Error ? err.message : err);
    }
    console.log(`next pass in ${config.pollIntervalSeconds}s`);
    await sleep(config.pollIntervalSeconds * 1000);
  }
}
