CREATE TABLE links (
 id TEXT PRIMARY KEY, original_url TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
 domain TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 image TEXT, favicon TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE INDEX links_domain ON links(domain);
CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
CREATE TABLE link_tags (link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(link_id, tag_id));
CREATE INDEX link_tags_tag ON link_tags(tag_id);
