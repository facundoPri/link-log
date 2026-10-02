-- Rollback of 0013_ownership.sql. PREFERRED rollback is restoring the pre-migration backup
-- (local: `bun scripts/adjudicate-legacy.ts backup` copy; remote: D1 Time Travel / export).
-- This script is only safe while at most one person's data exists: it drops ownership, so rows of
-- different users would merge into one global library. If two owners saved the same URL, tag or
-- lens name, the global UNIQUE constraints fail and the whole script aborts without changes.
-- batches, browser_requests and browser_groups keep a nullable, unused user_id column: SQLite
-- cannot drop a column that carries a REFERENCES clause without rebuilding the Browser tables too.
-- Run with the app stopped:
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0013_ownership.down.sql
-- then run code from before FAC-40/41.
PRAGMA defer_foreign_keys = true;
DROP TRIGGER IF EXISTS links_owner_required;
DROP TRIGGER IF EXISTS tags_owner_required;
DROP TRIGGER IF EXISTS lenses_owner_required;
DROP TRIGGER IF EXISTS batches_owner_required;
DROP TRIGGER IF EXISTS usage_owner_required;
DROP TRIGGER IF EXISTS browser_requests_owner_required;
DROP TRIGGER IF EXISTS browser_groups_owner_required;
DROP TRIGGER IF EXISTS links_owner_immutable;
DROP TRIGGER IF EXISTS tags_owner_immutable;
DROP TRIGGER IF EXISTS lenses_owner_immutable;
DROP TRIGGER IF EXISTS batches_owner_immutable;
DROP TRIGGER IF EXISTS usage_owner_immutable;
DROP TRIGGER IF EXISTS browser_requests_owner_immutable;
DROP TRIGGER IF EXISTS browser_groups_owner_immutable;
DROP TRIGGER IF EXISTS link_tags_same_owner;
DROP TRIGGER IF EXISTS jobs_same_owner;
DROP TRIGGER IF EXISTS browser_requests_same_owner;
DROP TRIGGER IF EXISTS browser_targets_owned_request;
DROP TRIGGER IF EXISTS tag_evaluations_same_owner;
DROP TRIGGER IF EXISTS lens_results_same_owner;
DROP TRIGGER IF EXISTS usage_same_owner;
DROP TRIGGER IF EXISTS media_items_owned_link;
DROP TRIGGER IF EXISTS hidden_related_owned_link;
DROP INDEX IF EXISTS batches_owner_created;
DROP INDEX IF EXISTS browser_requests_owner;
DROP INDEX IF EXISTS browser_groups_owner;
-- The kept owner columns go back to NULL: otherwise dropping "user" later (0012_auth.down.sql) would
-- cascade-delete every batch, job and Browser row through them.
UPDATE batches SET user_id=NULL;
UPDATE browser_requests SET user_id=NULL;
UPDATE browser_groups SET user_id=NULL;

CREATE TABLE links_prev (
 id TEXT PRIMARY KEY, original_url TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
 domain TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 image TEXT, favicon TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 metadata_started_at TEXT, content_key TEXT, content_version INTEGER NOT NULL DEFAULT 0, content_source TEXT,
 content_state TEXT NOT NULL DEFAULT 'missing', content_error TEXT, content_updated_at TEXT, content_details TEXT
);
INSERT INTO links_prev SELECT id,original_url,url,domain,title,description,image,favicon,status,created_at,metadata_started_at,content_key,content_version,content_source,content_state,content_error,content_updated_at,content_details FROM links;
CREATE TABLE tags_prev (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 description TEXT NOT NULL DEFAULT '', threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1), version INTEGER NOT NULL DEFAULT 1);
INSERT INTO tags_prev SELECT id,name,description,threshold,version FROM tags;
CREATE TABLE lenses_prev (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 type TEXT NOT NULL CHECK(type IN ('noul','choice','multi','score')),
 question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
 threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'library' CHECK(scope IN ('library','browser'))
);
INSERT INTO lenses_prev SELECT id,name,type,question,options,threshold,version,created_at,scope FROM lenses;
CREATE TABLE link_tags_prev (link_id TEXT NOT NULL REFERENCES links_prev(id) ON DELETE CASCADE,
 tag_id TEXT NOT NULL REFERENCES tags_prev(id) ON DELETE CASCADE, origin TEXT NOT NULL DEFAULT 'manual', PRIMARY KEY(link_id, tag_id));
INSERT INTO link_tags_prev SELECT link_id,tag_id,origin FROM link_tags;
CREATE TABLE jobs_prev (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
 link_id TEXT REFERENCES links_prev(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued', step TEXT NOT NULL DEFAULT 'En cola',
 error TEXT, result TEXT, created_at TEXT NOT NULL, completed_at TEXT,
 target_id TEXT REFERENCES browser_targets(id) ON DELETE CASCADE,
 CHECK((link_id IS NOT NULL) + (target_id IS NOT NULL) = 1)
);
INSERT INTO jobs_prev SELECT id,batch_id,link_id,status,step,error,result,created_at,completed_at,target_id FROM jobs;
CREATE TABLE tag_evaluations_prev (
 link_id TEXT NOT NULL REFERENCES links_prev(id) ON DELETE CASCADE,
 tag_id TEXT NOT NULL REFERENCES tags_prev(id) ON DELETE CASCADE,
 probability REAL NOT NULL CHECK(probability>=0 AND probability<=1),
 threshold REAL NOT NULL, tag_version INTEGER NOT NULL, description TEXT NOT NULL,
 content_version INTEGER NOT NULL, model TEXT NOT NULL, evaluated_at TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES batches(id), chunks INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(link_id,tag_id)
);
INSERT INTO tag_evaluations_prev SELECT link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id,chunks FROM tag_evaluations;
CREATE TABLE lens_results_prev (
 link_id TEXT NOT NULL REFERENCES links_prev(id) ON DELETE CASCADE,
 lens_id TEXT NOT NULL REFERENCES lenses_prev(id) ON DELETE CASCADE,
 answer TEXT NOT NULL, lens_version INTEGER NOT NULL, content_version INTEGER NOT NULL,
 model TEXT NOT NULL, evaluated_at TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES batches(id),
 PRIMARY KEY(link_id,lens_id)
);
INSERT INTO lens_results_prev SELECT link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id FROM lens_results;
CREATE TABLE usage_events_prev (
 id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), job_id TEXT REFERENCES jobs_prev(id) ON DELETE SET NULL,
 link_id TEXT REFERENCES links_prev(id) ON DELETE SET NULL,
 provider TEXT NOT NULL, service TEXT NOT NULL, model TEXT,
 operation TEXT NOT NULL, status TEXT NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, browser_ms INTEGER,
 estimated_usd REAL, rate_snapshot TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, duration_ms INTEGER, error TEXT
);
INSERT INTO usage_events_prev SELECT id,batch_id,job_id,link_id,provider,service,model,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,rate_snapshot,created_at,duration_ms,error FROM usage_events;
CREATE TABLE provider_leases_prev (job_id TEXT PRIMARY KEY REFERENCES jobs_prev(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, pool TEXT NOT NULL DEFAULT 'browser');
INSERT INTO provider_leases_prev SELECT job_id,expires_at,pool FROM provider_leases;
CREATE TABLE media_items_prev (
  link_id TEXT NOT NULL REFERENCES links_prev(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL, position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')), url TEXT NOT NULL, preview_url TEXT,
  ocr_state TEXT NOT NULL DEFAULT 'pending' CHECK(ocr_state IN ('pending','done','no_text','failed','skipped')),
  ocr_text TEXT, ocr_error TEXT, ocr_model TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(link_id,media_key)
);
INSERT INTO media_items_prev SELECT link_id,media_key,position,kind,url,preview_url,ocr_state,ocr_text,ocr_error,ocr_model,updated_at FROM media_items;
CREATE TABLE hidden_related_links_prev (link_id TEXT NOT NULL REFERENCES links_prev(id) ON DELETE CASCADE,
  url TEXT NOT NULL, hidden_at TEXT NOT NULL, PRIMARY KEY (link_id, url));
INSERT INTO hidden_related_links_prev SELECT link_id,url,hidden_at FROM hidden_related_links;

DROP TABLE provider_leases;
DROP TABLE usage_events;
DROP TABLE tag_evaluations;
DROP TABLE lens_results;
DROP TABLE link_tags;
DROP TABLE media_items;
DROP TABLE hidden_related_links;
DROP TABLE jobs;
DROP TABLE tags;
DROP TABLE lenses;
DROP TABLE links;

ALTER TABLE links_prev RENAME TO links;
ALTER TABLE tags_prev RENAME TO tags;
ALTER TABLE lenses_prev RENAME TO lenses;
ALTER TABLE link_tags_prev RENAME TO link_tags;
ALTER TABLE jobs_prev RENAME TO jobs;
ALTER TABLE tag_evaluations_prev RENAME TO tag_evaluations;
ALTER TABLE lens_results_prev RENAME TO lens_results;
ALTER TABLE usage_events_prev RENAME TO usage_events;
ALTER TABLE provider_leases_prev RENAME TO provider_leases;
ALTER TABLE media_items_prev RENAME TO media_items;
ALTER TABLE hidden_related_links_prev RENAME TO hidden_related_links;

CREATE INDEX links_domain ON links(domain);
CREATE INDEX link_tags_tag ON link_tags(tag_id);
CREATE INDEX jobs_batch ON jobs(batch_id);
CREATE UNIQUE INDEX jobs_active_link ON jobs(link_id) WHERE status IN ('queued','running') AND link_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_active_target ON jobs(target_id) WHERE status IN ('queued','running') AND target_id IS NOT NULL;
CREATE INDEX jobs_target ON jobs(target_id);
CREATE INDEX usage_batch ON usage_events(batch_id);
CREATE INDEX media_items_order ON media_items(link_id,position);

DELETE FROM d1_migrations WHERE name='0013_ownership.sql';
