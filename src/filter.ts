import type { Config } from './config.js';
import type { IssueNode } from './types.js';

export function labelNames(issue: IssueNode): string[] {
  return (issue.labels.nodes ?? [])
    .filter((l): l is { name: string } => l != null)
    .map((l) => l.name);
}

/**
 * Client-side filters (§7). The query already enforces open/unassigned/
 * language/freshness server-side; stars must never appear in the query.
 */
export function keepIssue(issue: IssueNode, config: Config): boolean {
  const repo = issue.repository;
  if (repo.stargazerCount < config.starsMin) return false;
  if (repo.isArchived || repo.isDisabled) return false;

  if (config.labelFilter.length > 0) {
    const names = labelNames(issue).map((n) => n.toLowerCase());
    const wanted = config.labelFilter.map((n) => n.toLowerCase());
    if (!wanted.some((w) => names.includes(w))) return false;
  }
  return true;
}

export function filterIssues(issues: IssueNode[], config: Config): IssueNode[] {
  return issues.filter((issue) => keepIssue(issue, config));
}
