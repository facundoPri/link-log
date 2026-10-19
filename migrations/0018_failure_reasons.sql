-- FAC-48: classified failure reasons and visible retry attempts.
ALTER TABLE links ADD COLUMN preview_reason TEXT;
ALTER TABLE links ADD COLUMN content_reason TEXT;
ALTER TABLE jobs ADD COLUMN attempt INTEGER;
ALTER TABLE jobs ADD COLUMN max_attempts INTEGER;
ALTER TABLE jobs ADD COLUMN reason TEXT;
ALTER TABLE jobs ADD COLUMN preview_reason TEXT;
