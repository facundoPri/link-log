ALTER TABLE tags ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE tags ADD COLUMN threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1);
ALTER TABLE tags ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE link_tags ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE links ADD COLUMN content_key TEXT;
ALTER TABLE links ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN content_source TEXT;
ALTER TABLE links ADD COLUMN content_state TEXT NOT NULL DEFAULT 'missing';
ALTER TABLE links ADD COLUMN content_error TEXT;
ALTER TABLE links ADD COLUMN content_updated_at TEXT;
CREATE TABLE batches (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
 link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued', step TEXT NOT NULL DEFAULT 'En cola',
 error TEXT, result TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX jobs_batch ON jobs(batch_id);
CREATE UNIQUE INDEX jobs_active_link ON jobs(link_id) WHERE status IN ('queued','running');
CREATE TABLE tag_evaluations (
 link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
 probability REAL NOT NULL CHECK(probability>=0 AND probability<=1),
 threshold REAL NOT NULL, tag_version INTEGER NOT NULL, description TEXT NOT NULL,
 content_version INTEGER NOT NULL, model TEXT NOT NULL, evaluated_at TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES batches(id), chunks INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(link_id,tag_id)
);
CREATE TABLE usage_events (
 id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
 link_id TEXT REFERENCES links(id) ON DELETE SET NULL,
 provider TEXT NOT NULL, service TEXT NOT NULL, model TEXT,
 operation TEXT NOT NULL, status TEXT NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, browser_ms INTEGER,
 estimated_usd REAL, rate_snapshot TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, duration_ms INTEGER, error TEXT
);
CREATE INDEX usage_batch ON usage_events(batch_id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
