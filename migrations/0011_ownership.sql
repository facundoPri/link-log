-- FAC-41: every library row belongs to one Better Auth user.
--
-- Existing rows keep their IDs, relations and content but get user_id NULL: unassigned and
-- unreachable through the API until scripts/adjudicate-legacy.ts assigns them to a verified user.
-- Nothing is assigned to the first signup or to a fixture.
--
-- Uniqueness moves from global to per owner, which needs table rebuilds. In SQLite, DROP TABLE on a
-- parent runs an implicit DELETE that fires ON DELETE CASCADE even with deferred foreign keys, and
-- D1 cannot turn foreign keys off. So every table in the foreign-key graph is copied into a *_next
-- table that references only *_next parents, old tables are dropped children-first (nothing left to
-- cascade into), and the copies are renamed (renames rewrite the references to the final names).
-- Rollback: scripts/migrations/rollback/0011_ownership.down.sql or restore the pre-migration backup.
PRAGMA defer_foreign_keys = true;

CREATE TABLE links_next (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL, url TEXT NOT NULL, domain TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', image TEXT, favicon TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, metadata_started_at TEXT,
  content_key TEXT, content_version INTEGER NOT NULL DEFAULT 0, content_source TEXT,
  content_state TEXT NOT NULL DEFAULT 'missing', content_error TEXT, content_updated_at TEXT,
  content_details TEXT
);
INSERT INTO links_next(id,user_id,original_url,url,domain,title,description,image,favicon,status,created_at,metadata_started_at,content_key,content_version,content_source,content_state,content_error,content_updated_at,content_details)
  SELECT id,NULL,original_url,url,domain,title,description,image,favicon,status,created_at,metadata_started_at,content_key,content_version,content_source,content_state,content_error,content_updated_at,content_details FROM links;

CREATE TABLE tags_next (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO tags_next(id,user_id,name,description,threshold,version) SELECT id,NULL,name,description,threshold,version FROM tags;

CREATE TABLE lenses_next (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL CHECK(type IN ('noul','choice','multi','score')),
  question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
  threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1),
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
INSERT INTO lenses_next(id,user_id,name,type,question,options,threshold,version,created_at)
  SELECT id,NULL,name,type,question,options,threshold,version,created_at FROM lenses;

CREATE TABLE batches_next (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO batches_next(id,user_id,kind,config,created_at) SELECT id,NULL,kind,config,created_at FROM batches;

CREATE TABLE link_tags_next (
  link_id TEXT NOT NULL REFERENCES links_next(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags_next(id) ON DELETE CASCADE,
  origin TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY(link_id, tag_id)
);
INSERT INTO link_tags_next(link_id,tag_id,origin) SELECT link_id,tag_id,origin FROM link_tags;

CREATE TABLE jobs_next (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches_next(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES links_next(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', step TEXT NOT NULL DEFAULT 'En cola',
  error TEXT, result TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
INSERT INTO jobs_next(id,batch_id,link_id,status,step,error,result,created_at,completed_at)
  SELECT id,batch_id,link_id,status,step,error,result,created_at,completed_at FROM jobs;

CREATE TABLE tag_evaluations_next (
  link_id TEXT NOT NULL REFERENCES links_next(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags_next(id) ON DELETE CASCADE,
  probability REAL NOT NULL CHECK(probability>=0 AND probability<=1),
  threshold REAL NOT NULL, tag_version INTEGER NOT NULL, description TEXT NOT NULL,
  content_version INTEGER NOT NULL, model TEXT NOT NULL, evaluated_at TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches_next(id) ON DELETE CASCADE,
  chunks INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(link_id,tag_id)
);
INSERT INTO tag_evaluations_next(link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id,chunks)
  SELECT link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id,chunks FROM tag_evaluations;

CREATE TABLE lens_results_next (
  link_id TEXT NOT NULL REFERENCES links_next(id) ON DELETE CASCADE,
  lens_id TEXT NOT NULL REFERENCES lenses_next(id) ON DELETE CASCADE,
  answer TEXT NOT NULL, lens_version INTEGER NOT NULL, content_version INTEGER NOT NULL,
  model TEXT NOT NULL, evaluated_at TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches_next(id) ON DELETE CASCADE,
  PRIMARY KEY(link_id,lens_id)
);
INSERT INTO lens_results_next(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id)
  SELECT link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id FROM lens_results;

-- Usage keeps its owner directly: link/job references become NULL when those rows are deleted.
CREATE TABLE usage_events_next (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  batch_id TEXT REFERENCES batches_next(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs_next(id) ON DELETE SET NULL,
  link_id TEXT REFERENCES links_next(id) ON DELETE SET NULL,
  provider TEXT NOT NULL, service TEXT NOT NULL, model TEXT,
  operation TEXT NOT NULL, status TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, browser_ms INTEGER,
  estimated_usd REAL, rate_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, duration_ms INTEGER, error TEXT
);
INSERT INTO usage_events_next(id,user_id,batch_id,job_id,link_id,provider,service,model,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,rate_snapshot,created_at,duration_ms,error)
  SELECT id,NULL,batch_id,job_id,link_id,provider,service,model,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,rate_snapshot,created_at,duration_ms,error FROM usage_events;

CREATE TABLE provider_leases_next (
  job_id TEXT PRIMARY KEY REFERENCES jobs_next(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  pool TEXT NOT NULL DEFAULT 'browser'
);
INSERT INTO provider_leases_next(job_id,expires_at,pool) SELECT job_id,expires_at,pool FROM provider_leases;

CREATE TABLE media_items_next (
  link_id TEXT NOT NULL REFERENCES links_next(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  url TEXT NOT NULL,
  preview_url TEXT,
  ocr_state TEXT NOT NULL DEFAULT 'pending' CHECK(ocr_state IN ('pending','done','no_text','failed','skipped')),
  ocr_text TEXT, ocr_error TEXT, ocr_model TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(link_id,media_key)
);
INSERT INTO media_items_next(link_id,media_key,position,kind,url,preview_url,ocr_state,ocr_text,ocr_error,ocr_model,updated_at)
  SELECT link_id,media_key,position,kind,url,preview_url,ocr_state,ocr_text,ocr_error,ocr_model,updated_at FROM media_items;

CREATE TABLE hidden_related_links_next (
  link_id TEXT NOT NULL REFERENCES links_next(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (link_id, url)
);
INSERT INTO hidden_related_links_next(link_id,url,hidden_at) SELECT link_id,url,hidden_at FROM hidden_related_links;

-- Children first: once they are gone nothing references the old parents, so no cascade can fire.
DROP TABLE provider_leases;
DROP TABLE usage_events;
DROP TABLE tag_evaluations;
DROP TABLE lens_results;
DROP TABLE link_tags;
DROP TABLE media_items;
DROP TABLE hidden_related_links;
DROP TABLE jobs;
DROP TABLE batches;
DROP TABLE tags;
DROP TABLE lenses;
DROP TABLE links;

ALTER TABLE links_next RENAME TO links;
ALTER TABLE tags_next RENAME TO tags;
ALTER TABLE lenses_next RENAME TO lenses;
ALTER TABLE batches_next RENAME TO batches;
ALTER TABLE link_tags_next RENAME TO link_tags;
ALTER TABLE jobs_next RENAME TO jobs;
ALTER TABLE tag_evaluations_next RENAME TO tag_evaluations;
ALTER TABLE lens_results_next RENAME TO lens_results;
ALTER TABLE usage_events_next RENAME TO usage_events;
ALTER TABLE provider_leases_next RENAME TO provider_leases;
ALTER TABLE media_items_next RENAME TO media_items;
ALTER TABLE hidden_related_links_next RENAME TO hidden_related_links;

CREATE UNIQUE INDEX links_owner_original_url ON links(user_id, original_url);
CREATE INDEX links_owner_url ON links(user_id, url);
CREATE INDEX links_owner_created ON links(user_id, created_at);
CREATE INDEX links_domain ON links(domain);
CREATE UNIQUE INDEX tags_owner_name ON tags(user_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX lenses_owner_name ON lenses(user_id, name COLLATE NOCASE);
CREATE INDEX batches_owner_created ON batches(user_id, created_at);
CREATE INDEX link_tags_tag ON link_tags(tag_id);
CREATE INDEX jobs_batch ON jobs(batch_id);
CREATE UNIQUE INDEX jobs_active_link ON jobs(link_id) WHERE status IN ('queued','running');
CREATE INDEX usage_batch ON usage_events(batch_id);
CREATE INDEX usage_owner_created ON usage_events(user_id, created_at);
CREATE INDEX media_items_order ON media_items(link_id,position);

-- Defense in depth below the API: new rows need an owner, owners never change once set
-- (adjudication only fills NULL), and relations can only join rows of the same owner.
CREATE TRIGGER links_owner_required BEFORE INSERT ON links WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
CREATE TRIGGER tags_owner_required BEFORE INSERT ON tags WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
CREATE TRIGGER lenses_owner_required BEFORE INSERT ON lenses WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
CREATE TRIGGER batches_owner_required BEFORE INSERT ON batches WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
CREATE TRIGGER usage_owner_required BEFORE INSERT ON usage_events WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;

CREATE TRIGGER links_owner_immutable BEFORE UPDATE OF user_id ON links
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'owner is immutable'); END;
CREATE TRIGGER tags_owner_immutable BEFORE UPDATE OF user_id ON tags
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'owner is immutable'); END;
CREATE TRIGGER lenses_owner_immutable BEFORE UPDATE OF user_id ON lenses
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'owner is immutable'); END;
CREATE TRIGGER batches_owner_immutable BEFORE UPDATE OF user_id ON batches
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'owner is immutable'); END;
CREATE TRIGGER usage_owner_immutable BEFORE UPDATE OF user_id ON usage_events
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'owner is immutable'); END;

CREATE TRIGGER link_tags_same_owner BEFORE INSERT ON link_tags
WHEN (SELECT user_id FROM links WHERE id=NEW.link_id) IS NULL
  OR (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM tags WHERE id=NEW.tag_id)
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
CREATE TRIGGER jobs_same_owner BEFORE INSERT ON jobs
WHEN (SELECT user_id FROM links WHERE id=NEW.link_id) IS NULL
  OR (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM batches WHERE id=NEW.batch_id)
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
CREATE TRIGGER tag_evaluations_same_owner BEFORE INSERT ON tag_evaluations
WHEN (SELECT user_id FROM links WHERE id=NEW.link_id) IS NULL
  OR (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM tags WHERE id=NEW.tag_id)
  OR (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM batches WHERE id=NEW.batch_id)
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
CREATE TRIGGER lens_results_same_owner BEFORE INSERT ON lens_results
WHEN (SELECT user_id FROM links WHERE id=NEW.link_id) IS NULL
  OR (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM lenses WHERE id=NEW.lens_id)
  OR (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT (SELECT user_id FROM batches WHERE id=NEW.batch_id)
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
CREATE TRIGGER usage_same_owner BEFORE INSERT ON usage_events
WHEN (NEW.batch_id IS NOT NULL AND (SELECT user_id FROM batches WHERE id=NEW.batch_id) IS NOT NEW.user_id)
  OR (NEW.link_id IS NOT NULL AND (SELECT user_id FROM links WHERE id=NEW.link_id) IS NOT NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'cross-owner relation'); END;
CREATE TRIGGER media_items_owned_link BEFORE INSERT ON media_items
WHEN (SELECT user_id FROM links WHERE id=NEW.link_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
CREATE TRIGGER hidden_related_owned_link BEFORE INSERT ON hidden_related_links
WHEN (SELECT user_id FROM links WHERE id=NEW.link_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'owner required'); END;
