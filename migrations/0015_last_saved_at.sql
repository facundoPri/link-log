-- Preserve the first save date; re-saving only changes the library's recency order.
ALTER TABLE links ADD COLUMN last_saved_at TEXT;
CREATE INDEX links_user_last_saved ON links(user_id,coalesce(last_saved_at,created_at) DESC,created_at DESC,id DESC);
