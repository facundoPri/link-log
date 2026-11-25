-- Rollback of 0029_jobs_outlive_links.sql. Jobs of deleted links (no link and no browser target) can't be
-- represented before 0029, so they are dropped and their usage rows keep their cost without a job. Everything else
-- is copied back unchanged.
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0029_jobs_outlive_links.down.sql
PRAGMA defer_foreign_keys = true;

CREATE TABLE jobs_next (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES links(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', step TEXT NOT NULL DEFAULT 'En cola',
  error TEXT, result TEXT, created_at TEXT NOT NULL, completed_at TEXT,
  target_id TEXT REFERENCES browser_targets(id) ON DELETE CASCADE, attempt INTEGER, max_attempts INTEGER, reason TEXT, preview_reason TEXT, attempt_started_at INTEGER, attempt_budget_ms INTEGER, adapter TEXT, jev_call TEXT, jev_outcome TEXT, content_source TEXT, started_at INTEGER,
  CHECK((link_id IS NOT NULL) + (target_id IS NOT NULL) = 1)
);
INSERT INTO jobs_next(id,batch_id,link_id,status,step,error,result,created_at,completed_at,target_id,attempt,max_attempts,reason,preview_reason,attempt_started_at,attempt_budget_ms,adapter,jev_call,jev_outcome,content_source,started_at)
  SELECT id,batch_id,link_id,status,step,error,result,created_at,completed_at,target_id,attempt,max_attempts,reason,preview_reason,attempt_started_at,attempt_budget_ms,adapter,jev_call,jev_outcome,content_source,started_at FROM jobs WHERE link_id IS NOT NULL OR target_id IS NOT NULL;

CREATE TABLE usage_events_next (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs_next(id) ON DELETE SET NULL,
  link_id TEXT REFERENCES links(id) ON DELETE SET NULL,
  provider TEXT NOT NULL, service TEXT NOT NULL, model TEXT,
  operation TEXT NOT NULL, status TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, browser_ms INTEGER,
  estimated_usd REAL, rate_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, duration_ms INTEGER, error TEXT
);
INSERT INTO usage_events_next SELECT id,user_id,batch_id,CASE WHEN job_id IN (SELECT id FROM jobs_next) THEN job_id END,link_id,provider,service,model,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,rate_snapshot,created_at,duration_ms,error FROM usage_events;

CREATE TABLE provider_leases_next (
  job_id TEXT PRIMARY KEY REFERENCES jobs_next(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  pool TEXT NOT NULL DEFAULT 'browser'
);
INSERT INTO provider_leases_next SELECT job_id,expires_at,pool FROM provider_leases WHERE job_id IN (SELECT id FROM jobs_next);

DROP TABLE provider_leases;
DROP TABLE usage_events;
DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;
ALTER TABLE usage_events_next RENAME TO usage_events;
ALTER TABLE provider_leases_next RENAME TO provider_leases;

CREATE INDEX jobs_batch ON jobs(batch_id);
CREATE UNIQUE INDEX jobs_active_link ON jobs(link_id) WHERE status IN ('queued','running') AND link_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_active_target ON jobs(target_id) WHERE status IN ('queued','running') AND target_id IS NOT NULL;
CREATE INDEX jobs_target ON jobs(target_id);
CREATE INDEX jobs_waiting_link ON jobs(link_id, created_at) WHERE status='waiting';
CREATE INDEX jobs_link_status ON jobs(link_id, status);
CREATE INDEX usage_batch ON usage_events(batch_id);
CREATE INDEX usage_owner_created ON usage_events(user_id, created_at);

CREATE TRIGGER jobs_same_owner BEFORE INSERT ON jobs
WHEN (SELECT user_id FROM batches WHERE id=NEW.batch_id) IS NULL
  OR (NEW.link_id IS NOT NULL AND (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM batches WHERE id=NEW.batch_id))
  OR (NEW.target_id IS NOT NULL AND (SELECT r.user_id FROM browser_targets t JOIN browser_requests r ON r.request_id=t.request_id WHERE t.id=NEW.target_id) IS NOT (SELECT user_id FROM batches WHERE id=NEW.batch_id))
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
CREATE TRIGGER usage_owner_required BEFORE INSERT ON usage_events WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
CREATE TRIGGER usage_owner_immutable BEFORE UPDATE OF user_id ON usage_events
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'owner is immutable'); END;
CREATE TRIGGER usage_same_owner BEFORE INSERT ON usage_events
WHEN (NEW.batch_id IS NOT NULL AND (SELECT user_id FROM batches WHERE id=NEW.batch_id) IS NOT NEW.user_id)
  OR (NEW.link_id IS NOT NULL AND (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
DELETE FROM d1_migrations WHERE name='0029_jobs_outlive_links.sql';
