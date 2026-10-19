-- Existing useful titles retain their origin as legacy; new URL labels are explicitly placeholders.
ALTER TABLE links ADD COLUMN title_source TEXT NOT NULL DEFAULT 'placeholder' CHECK(title_source IN ('placeholder','metadata','extraction','legacy'));
UPDATE links SET title_source='legacy' WHERE trim(title)<>'' AND lower(trim(title))<>lower(domain) AND lower(trim(title))<>lower(url)
  AND lower(trim(title)) NOT IN ('youtube','youtube video','youtube post','instagram post','instagram reel','x post','twitter post');
-- Record what was sent, independent of later extraction/metadata changes.
ALTER TABLE jobs ADD COLUMN content_source TEXT;
