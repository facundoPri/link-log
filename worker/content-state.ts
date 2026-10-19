export function preservedContentStateSql(whenEmpty: "failed" | "missing"): string {
  return `CASE WHEN content_key IS NULL THEN '${whenEmpty}' WHEN content_source='preview' OR json_extract(content_details,'$.completeness')='unverified' OR coalesce(json_array_length(json_extract(content_details,'$.issues')),0)>0 THEN 'partial' ELSE 'ready' END`;
}
// Undoing a queued extraction that never finished (cancelled or interrupted): the link goes back to how it
// was, including a previous failure, whose error and reason the queued state kept.
export const restoredContentStateSql = `CASE WHEN content_key IS NULL AND content_error IS NOT NULL THEN 'failed' ELSE ${preservedContentStateSql("missing")} END`;
