CREATE TABLE hidden_related_links (
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (link_id, url)
);
