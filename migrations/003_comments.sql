-- Comments count: signal for how contested an issue is (0 comments = truly up
-- for grabs). Refreshed on upsert whenever the poller re-encounters an issue.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS comments INTEGER NOT NULL DEFAULT 0;