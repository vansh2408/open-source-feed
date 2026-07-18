/** An issue node as returned by the GraphQL search (inline fragment on Issue). */
export interface IssueNode {
  id: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  comments: { totalCount: number };
  labels: { nodes: Array<{ name: string } | null> | null };
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isArchived: boolean;
    isDisabled: boolean;
    primaryLanguage: { name: string } | null;
  };
}

export interface RateLimitInfo {
  remaining: number;
  resetAt: string;
  cost: number;
}

export interface SearchPage {
  rateLimit: RateLimitInfo;
  search: {
    issueCount: number;
    // The search can return non-Issue nodes (empty objects) or nulls; we
    // narrow to IssueNode by checking for `id` after fetch.
    nodes: Array<Partial<IssueNode> | null> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ type?: string; message: string }>;
}

/** Shape persisted to the `issues` table. */
export interface IssueRow {
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
  created_at: string;
  updated_at: string;
}

export interface PollState {
  language: string;
  watermark: Date;
  last_poll_at: Date | null;
  last_poll_count: number;
}

export interface PollResult {
  language: string;
  fetched: number;
  kept: number;
  inserted: number;
  updated: number;
  watermark: string;
  rateLimitRemaining: number | null;
}
