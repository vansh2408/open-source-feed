import type { GraphQLResponse, IssueNode, RateLimitInfo, SearchPage } from './types.js';

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

/** Stop paging and wait for reset when the point budget drops below this. */
const RATE_LIMIT_SAFETY_BUFFER = 100;
/** Pause between pages to stay clear of the secondary (per-minute) limit. */
const INTER_PAGE_DELAY_MS = 1000;
const MAX_RETRIES = 3;

const FETCH_ISSUES_QUERY = `
query FetchIssues($q: String!, $cursor: String) {
  rateLimit { remaining resetAt cost }
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    nodes {
      ... on Issue {
        id
        number
        title
        url
        createdAt
        updatedAt
        author { login }
        comments { totalCount }
        labels(first: 15) { nodes { name } }
        repository {
          nameWithOwner
          stargazerCount
          isArchived
          isDisabled
          primaryLanguage { name }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

/** Second-precision ISO 8601: GitHub search does not accept milliseconds. */
export function toSearchIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the issue-search query string. Stars are deliberately absent: the
 * `stars:` qualifier is invalid in issue search and is filtered client-side.
 * Label narrowing is one label per query (§6); callers run one pass per label.
 */
export function buildSearchQuery(language: string, watermarkIso: string, label?: string): string {
  let q = `is:issue is:open no:assignee language:${language} created:>=${watermarkIso} sort:created-desc`;
  if (label) q += ` label:"${label}"`;
  if (q.includes('stars:')) {
    throw new Error(`Invalid search query (contains "stars:", which issue search rejects): ${q}`);
  }
  return q;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIssueNode(node: Partial<IssueNode> | null): node is IssueNode {
  return node != null && typeof node.id === 'string' && node.repository != null;
}

async function graphqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  opts: { ignoreNotFound?: boolean } = {}
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'github-issues-feed',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000;
      if (attempt > MAX_RETRIES) {
        throw new Error(`GitHub API rate-limited (HTTP ${res.status}) after ${MAX_RETRIES} retries`);
      }
      console.warn(`HTTP ${res.status} from GitHub; waiting ${waitMs / 1000}s (attempt ${attempt})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`GitHub API error: HTTP ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors?.length) {
      // nodes(ids:) reports deleted/inaccessible ids as NOT_FOUND errors while
      // still returning partial data; callers that expect that opt in and
      // treat the missing ids as gone.
      const fatal = opts.ignoreNotFound
        ? body.errors.filter((e) => e.type !== 'NOT_FOUND')
        : body.errors;
      if (fatal.length > 0) {
        throw new Error(`GraphQL errors: ${fatal.map((e) => e.message).join('; ')}`);
      }
    }
    if (!body.data) {
      throw new Error('GraphQL response had no data');
    }
    return body.data;
  }
}

function fetchPage(token: string, q: string, cursor: string | null): Promise<SearchPage> {
  return graphqlRequest<SearchPage>(token, FETCH_ISSUES_QUERY, { q, cursor });
}

export interface SearchResult {
  issues: IssueNode[];
  rateLimit: RateLimitInfo | null;
}

const VERIFY_ISSUES_QUERY = `
query VerifyIssues($ids: [ID!]!) {
  rateLimit { remaining resetAt cost }
  nodes(ids: $ids) {
    ... on Issue {
      id
      state
      assignees(first: 1) { totalCount }
      comments { totalCount }
    }
  }
}
`;

interface VerifyPage {
  rateLimit: RateLimitInfo;
  nodes: Array<{
    id?: string;
    state?: string;
    assignees?: { totalCount: number };
    comments?: { totalCount: number };
  } | null>;
}

export interface IssueStatus {
  isOpen: boolean;
  isAssigned: boolean;
  comments: number;
}

/**
 * Re-check open/assigned status for stored issues by node id (Phase 3
 * enrichment). Batches of 100 ids per request. Ids that come back null
 * (issue/repo deleted or made private) are reported as not open.
 */
export async function verifyIssueStates(
  token: string,
  ids: string[]
): Promise<{ statuses: Map<string, IssueStatus>; rateLimit: RateLimitInfo | null }> {
  const statuses = new Map<string, IssueStatus>();
  let rateLimit: RateLimitInfo | null = null;

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await graphqlRequest<VerifyPage>(
      token,
      VERIFY_ISSUES_QUERY,
      { ids: batch },
      { ignoreNotFound: true }
    );
    rateLimit = data.rateLimit;

    const seen = new Set<string>();
    for (const node of data.nodes) {
      if (node?.id && node.state) {
        seen.add(node.id);
        statuses.set(node.id, {
          isOpen: node.state === 'OPEN',
          isAssigned: (node.assignees?.totalCount ?? 0) > 0,
          comments: node.comments?.totalCount ?? 0,
        });
      }
    }
    for (const id of batch) {
      if (!seen.has(id)) statuses.set(id, { isOpen: false, isAssigned: false, comments: 0 });
    }

    if (i + 100 < ids.length) await sleep(INTER_PAGE_DELAY_MS);
  }

  return { statuses, rateLimit };
}

/**
 * Run the search, following pagination until exhausted. Checks the rateLimit
 * block on every page and sleeps until reset when `remaining` dips below the
 * safety buffer.
 */
export async function searchAllIssues(token: string, q: string): Promise<SearchResult> {
  const issues: IssueNode[] = [];
  let rateLimit: RateLimitInfo | null = null;
  let cursor: string | null = null;

  for (let page = 1; ; page++) {
    const data = await fetchPage(token, q, cursor);
    rateLimit = data.rateLimit;

    const nodes = (data.search.nodes ?? []).filter(isIssueNode);
    issues.push(...nodes);
    console.log(
      `  page ${page}: ${nodes.length} issues (total matches: ${data.search.issueCount}, ` +
        `rateLimit remaining: ${rateLimit.remaining}, cost: ${rateLimit.cost})`
    );

    if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) break;
    cursor = data.search.pageInfo.endCursor;

    if (rateLimit.remaining < RATE_LIMIT_SAFETY_BUFFER) {
      const waitMs = Math.max(0, new Date(rateLimit.resetAt).getTime() - Date.now()) + 1000;
      console.warn(
        `rateLimit.remaining=${rateLimit.remaining} below buffer; sleeping ${Math.ceil(waitMs / 1000)}s until reset`
      );
      await sleep(waitMs);
    } else {
      await sleep(INTER_PAGE_DELAY_MS);
    }
  }

  return { issues, rateLimit };
}
