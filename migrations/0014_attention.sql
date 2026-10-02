-- FAC-48: persisted Needs attention, set only when a step fails for good and cleared by its success or Dismiss.
ALTER TABLE links ADD COLUMN attention_kind TEXT;
ALTER TABLE links ADD COLUMN attention_reason TEXT;
ALTER TABLE links ADD COLUMN attention_at TEXT;

-- Backfill from settled extractions only. Cancelled and interrupted jobs settled nothing, and neither did a
-- failed re-extract that kept earlier content (from a finished extraction or a paste). The latest extraction
-- that did settle decides: content attention when it failed without content, preview attention when its
-- preview failed. Jobs from before 0012 have no preview_reason; for them the link's failed preview is
-- attributed to that extraction (re-extracts rewrote it). Work still running settles later by itself.
WITH ext AS (
  SELECT j.rowid r,j.link_id,j.status,j.step,j.reason,j.preview_reason,j.adapter,j.created_at
  FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE b.kind='extract'
), settled AS (
  SELECT s.*,row_number() OVER (PARTITION BY s.link_id ORDER BY s.created_at DESC,s.r DESC) n
  FROM ext s JOIN links l ON l.id=s.link_id
  WHERE s.status='done' OR (s.status='failed' AND s.step NOT IN ('Cancelled','Interrupted') AND NOT (
    EXISTS (SELECT 1 FROM ext d WHERE d.link_id=s.link_id AND d.status='done' AND (d.created_at<s.created_at OR (d.created_at=s.created_at AND d.r<s.r)))
    OR coalesce(l.content_source='manual' AND l.content_updated_at<s.created_at,0)))
)
UPDATE links SET attention_kind='content',
  attention_reason=coalesce((SELECT s.reason FROM settled s WHERE s.link_id=links.id AND s.n=1),content_reason),
  attention_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE content_key IS NULL AND EXISTS (SELECT 1 FROM settled s WHERE s.link_id=links.id AND s.n=1 AND s.status='failed');

-- So did a preview fetched outside the queue (at save before jobs existed, or a failed "Retry preview"), when
-- no extraction that could have rewritten it started afterwards.
WITH ext AS (
  SELECT j.rowid r,j.link_id,j.status,j.step,j.reason,j.preview_reason,j.adapter,j.created_at
  FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE b.kind='extract'
), settled AS (
  SELECT s.*,row_number() OVER (PARTITION BY s.link_id ORDER BY s.created_at DESC,s.r DESC) n
  FROM ext s JOIN links l ON l.id=s.link_id
  WHERE s.status='done' OR (s.status='failed' AND s.step NOT IN ('Cancelled','Interrupted') AND NOT (
    EXISTS (SELECT 1 FROM ext d WHERE d.link_id=s.link_id AND d.status='done' AND (d.created_at<s.created_at OR (d.created_at=s.created_at AND d.r<s.r)))
    OR coalesce(l.content_source='manual' AND l.content_updated_at<s.created_at,0)))
)
UPDATE links SET attention_kind='preview',attention_reason=preview_reason,attention_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE attention_kind IS NULL AND status='failed' AND (
  EXISTS (SELECT 1 FROM settled s WHERE s.link_id=links.id AND s.n=1 AND (s.preview_reason IS NOT NULL OR s.adapter IS NULL))
  OR NOT EXISTS (SELECT 1 FROM ext e WHERE e.link_id=links.id
    AND e.status<>'queued' AND e.step<>'Cancelled' AND e.created_at>=coalesce(links.metadata_started_at,'')));
