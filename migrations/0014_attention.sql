-- FAC-48: persisted Needs attention, set only when a step fails for good and cleared by its success or Dismiss.
ALTER TABLE links ADD COLUMN attention_kind TEXT;
ALTER TABLE links ADD COLUMN attention_reason TEXT;
ALTER TABLE links ADD COLUMN attention_at TEXT;
-- Existing failures keep their place in the list; pending links stay neutral.
UPDATE links SET attention_kind='content',attention_reason=content_reason,attention_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE content_state='failed';
UPDATE links SET attention_kind='preview',attention_reason=preview_reason,attention_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE attention_kind IS NULL AND status='failed';
