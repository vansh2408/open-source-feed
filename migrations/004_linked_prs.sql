-- Issues with an open PR that declares it will close them ("fixes #N" or a
-- manual Development link) are taken, even while open+unassigned. Treated
-- exactly like assignment: skipped at ingest, flipped by enrichment, deleted
-- by retention. Count of OPEN closing PRs only — a merged PR closes the issue
-- (caught by is_open), an abandoned one stops counting.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS linked_prs INTEGER NOT NULL DEFAULT 0;