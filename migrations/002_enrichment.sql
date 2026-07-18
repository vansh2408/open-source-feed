-- Phase 3 enrichment: re-verified claimability status.
-- Poller inserts default to open/unassigned (that's what the search returns);
-- the enrich cron re-checks and flips these when an issue gets claimed/closed.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS is_open          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS is_assigned      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

-- The feed only ever reads claimable rows; keep that scan cheap.
CREATE INDEX IF NOT EXISTS idx_issues_claimable
  ON issues (created_at DESC)
  WHERE is_open AND NOT is_assigned;
