CREATE TABLE lenses (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 type TEXT NOT NULL CHECK(type IN ('noul','choice','score')),
 question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
 threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE lens_results (
 link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 lens_id TEXT NOT NULL REFERENCES lenses(id) ON DELETE CASCADE,
 answer TEXT NOT NULL, lens_version INTEGER NOT NULL, content_version INTEGER NOT NULL,
 model TEXT NOT NULL, evaluated_at TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES batches(id),
 PRIMARY KEY(link_id,lens_id)
);
