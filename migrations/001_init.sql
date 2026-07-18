CREATE TABLE IF NOT EXISTS issues (
  id             TEXT PRIMARY KEY,          -- GitHub GraphQL node id (globally unique)
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,
  url            TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_stars     INTEGER NOT NULL,
  language       TEXT NOT NULL,             -- pass that found it: 'javascript' | 'typescript'
  labels         TEXT[] NOT NULL DEFAULT '{}',
  author_login   TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_repo_stars ON issues (repo_stars DESC);
CREATE INDEX IF NOT EXISTS idx_issues_labels     ON issues USING GIN (labels);

CREATE TABLE IF NOT EXISTS poll_state (
  language        TEXT PRIMARY KEY,         -- 'javascript' | 'typescript'
  watermark       TIMESTAMPTZ NOT NULL,     -- newest created_at seen for this language
  last_poll_at    TIMESTAMPTZ,
  last_poll_count INTEGER NOT NULL DEFAULT 0
);
