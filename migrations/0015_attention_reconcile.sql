-- FAC-48: correct the 0014 backfill against settled extractions. A preview failure from an extraction still
-- in progress is not final yet, and a failed re-extract that kept its previous content adds nothing.
-- A genuine failure that is being retried keeps (or gets) its place.
-- Settled extractions per link, newest first (cancelled and interrupted jobs never settled anything).
WITH settled AS (
  SELECT j.link_id, j.preview_reason, row_number() OVER (PARTITION BY j.link_id ORDER BY j.created_at DESC, j.rowid DESC) n
  FROM jobs j JOIN batches b ON b.id=j.batch_id
  WHERE b.kind='extract' AND j.status IN ('done','failed') AND j.step NOT IN ('Cancelled','Interrupted')
)
UPDATE links SET attention_kind=NULL,attention_reason=NULL,attention_at=NULL
WHERE attention_kind='preview'
  AND EXISTS (SELECT 1 FROM jobs a JOIN batches b ON b.id=a.batch_id
    WHERE a.link_id=links.id AND b.kind='extract' AND a.status IN ('queued','running') AND a.preview_reason IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM settled s WHERE s.link_id=links.id AND s.n=1 AND s.preview_reason IS NOT NULL);

WITH settled AS (
  SELECT j.link_id, j.status, j.preview_reason, row_number() OVER (PARTITION BY j.link_id ORDER BY j.created_at DESC, j.rowid DESC) n
  FROM jobs j JOIN batches b ON b.id=j.batch_id
  WHERE b.kind='extract' AND j.status IN ('done','failed') AND j.step NOT IN ('Cancelled','Interrupted')
)
UPDATE links SET attention_kind=NULL,attention_reason=NULL,attention_at=NULL
WHERE attention_kind='preview' AND content_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM settled s WHERE s.link_id=links.id AND s.n=1 AND s.status='failed' AND s.preview_reason IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM settled s WHERE s.link_id=links.id AND s.n=2 AND s.preview_reason IS NOT NULL);

-- Content that failed for good and is being extracted again (the old enqueue cleared its failure).
WITH settled AS (
  SELECT j.link_id, j.status, j.step, j.reason, row_number() OVER (PARTITION BY j.link_id ORDER BY j.created_at DESC, j.rowid DESC) n
  FROM jobs j JOIN batches b ON b.id=j.batch_id
  WHERE b.kind='extract' AND j.status IN ('done','failed') AND j.step NOT IN ('Cancelled','Interrupted')
)
UPDATE links SET attention_kind='content',
  attention_reason=(SELECT s.reason FROM settled s WHERE s.link_id=links.id AND s.n=1),
  attention_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE content_state='queued' AND content_key IS NULL AND attention_kind IS NOT 'content'
  AND EXISTS (SELECT 1 FROM settled s WHERE s.link_id=links.id AND s.n=1 AND s.status='failed' AND s.step='Needs attention');
