-- Browser view: a job evaluates either a saved link or an ephemeral browser capture.
-- Rebuilds `jobs` so link_id may be NULL for browser targets. Children of `jobs`
-- (usage_events, provider_leases) are rebuilt first: dropping a parent table runs an
-- implicit DELETE whose ON DELETE actions would null usage_events.job_id and drop leases.
PRAGMA defer_foreign_keys = true;

CREATE TABLE browser_requests (
 request_id TEXT PRIMARY KEY,
 payload_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('lens','autogroup')),
 batch_id TEXT NOT NULL REFERENCES batches(id),
 library_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE browser_targets (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES browser_requests(request_id),
 target_key TEXT NOT NULL,
 url TEXT NOT NULL,
 title TEXT NOT NULL,
 -- Temporary R2 snapshot; removed once the evaluation no longer needs it.
 capture_key TEXT,
 capture_meta TEXT NOT NULL,
 answer TEXT,
 model TEXT,
 evaluated_at TEXT,
 acked_at TEXT,
 expired_at TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(request_id, target_key)
);

CREATE TABLE jobs_next (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
 link_id TEXT REFERENCES links(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued', step TEXT NOT NULL DEFAULT 'En cola',
 error TEXT, result TEXT, created_at TEXT NOT NULL, completed_at TEXT,
 target_id TEXT REFERENCES browser_targets(id) ON DELETE CASCADE,
 CHECK((link_id IS NOT NULL) + (target_id IS NOT NULL) = 1)
);
INSERT INTO jobs_next(id,batch_id,link_id,status,step,error,result,created_at,completed_at)
 SELECT id,batch_id,link_id,status,step,error,result,created_at,completed_at FROM jobs;

CREATE TABLE usage_events_next (
 id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), job_id TEXT REFERENCES jobs_next(id) ON DELETE SET NULL,
 link_id TEXT REFERENCES links(id) ON DELETE SET NULL,
 provider TEXT NOT NULL, service TEXT NOT NULL, model TEXT,
 operation TEXT NOT NULL, status TEXT NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, browser_ms INTEGER,
 estimated_usd REAL, rate_snapshot TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, duration_ms INTEGER, error TEXT
);
INSERT INTO usage_events_next(id,batch_id,job_id,link_id,provider,service,model,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,rate_snapshot,created_at,duration_ms,error)
 SELECT id,batch_id,job_id,link_id,provider,service,model,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,rate_snapshot,created_at,duration_ms,error FROM usage_events;

CREATE TABLE provider_leases_next (
 job_id TEXT PRIMARY KEY REFERENCES jobs_next(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 pool TEXT NOT NULL DEFAULT 'browser'
);
INSERT INTO provider_leases_next(job_id,expires_at,pool) SELECT job_id,expires_at,pool FROM provider_leases;

DROP TABLE usage_events;
DROP TABLE provider_leases;
DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;
ALTER TABLE usage_events_next RENAME TO usage_events;
ALTER TABLE provider_leases_next RENAME TO provider_leases;
CREATE INDEX jobs_batch ON jobs(batch_id);
CREATE UNIQUE INDEX jobs_active_link ON jobs(link_id) WHERE status IN ('queued','running') AND link_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_active_target ON jobs(target_id) WHERE status IN ('queued','running') AND target_id IS NOT NULL;
CREATE INDEX usage_batch ON usage_events(batch_id);
CREATE INDEX browser_targets_request ON browser_targets(request_id);

-- Browser lenses stay out of All links; library lenses stay out of Browser.
ALTER TABLE lenses ADD COLUMN scope TEXT NOT NULL DEFAULT 'library' CHECK(scope IN ('library','browser'));

-- Pinned group definitions shared by every browser connected to this library.
-- Independent from tags and from native Chrome groups; names are not unique.
CREATE TABLE browser_groups (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 color TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
