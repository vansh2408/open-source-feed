-- The partial index from 002 predates linked_prs (004), so its predicate no
-- longer matches how claimable rows are actually selected and the planner had
-- to recheck every candidate. Restate it over the full predicate.
--
-- This now serves exactly one query: the store's hydrate/reload of the
-- claimable set (src/db.ts loadClaimableIssues). The request path is served
-- from memory and never reaches Postgres.

CREATE INDEX IF NOT EXISTS idx_issues_claimable_v2
  ON issues (created_at DESC)
  WHERE is_open AND NOT is_assigned AND linked_prs = 0;

DROP INDEX IF EXISTS idx_issues_claimable;