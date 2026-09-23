ALTER TABLE links ADD COLUMN content_details TEXT;
CREATE TABLE media_items (
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  url TEXT NOT NULL,
  preview_url TEXT,
  ocr_state TEXT NOT NULL DEFAULT 'pending' CHECK(ocr_state IN ('pending','done','no_text','failed','skipped')),
  ocr_text TEXT,
  ocr_error TEXT,
  ocr_model TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(link_id,media_key)
);
CREATE INDEX media_items_order ON media_items(link_id,position);
