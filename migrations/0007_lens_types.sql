PRAGMA defer_foreign_keys = true;
CREATE TABLE lenses_new (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 type TEXT NOT NULL CHECK(type IN ('noul','choice','multi','score')),
 question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
 threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold>=0 AND threshold<=1),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
INSERT INTO lenses_new SELECT * FROM lenses;
DROP TABLE lenses;
ALTER TABLE lenses_new RENAME TO lenses;
