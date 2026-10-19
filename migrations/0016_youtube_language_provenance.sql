-- A saved transcript in the available English track is usable. Language provenance lives in
-- transcript.reason; it is not an extraction error. Correct existing rows without another fetch.
WITH corrected AS (
  SELECT id, (
    SELECT json_group_array(value) FROM json_each(links.content_details, '$.issues')
    WHERE value NOT IN (
      'Original audio language could not be verified; English was used.',
      'Original-language captions were unavailable; English was used instead.'
    ) AND value NOT LIKE 'Original-language captions could not be loaded:%'
  ) issues
  FROM links
  WHERE content_key IS NOT NULL AND content_source='youtube'
    AND json_valid(content_details)
    AND json_extract(content_details,'$.type')='youtube-video'
    AND json_extract(content_details,'$.transcript.selectedLanguage') IS NOT NULL
    AND json_extract(content_details,'$.transcript.reason') IN ('english-original-unknown','english-fallback')
)
UPDATE links SET
  content_details=json_set(content_details,
    '$.issues',json(corrected.issues),
    '$.completeness',CASE WHEN json_array_length(corrected.issues)=0 THEN 'verified' ELSE 'unverified' END),
  content_state=CASE WHEN content_state='partial' AND json_array_length(corrected.issues)=0 THEN 'ready' ELSE content_state END,
  content_error=CASE WHEN content_error IN (
    'Original audio language could not be verified; English was used.',
    'Original-language captions were unavailable; English was used instead.'
  ) OR content_error LIKE 'Original-language captions could not be loaded:%'
    THEN json_extract(corrected.issues,'$[0]') ELSE content_error END
FROM corrected WHERE links.id=corrected.id;
