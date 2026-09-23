export function preservedContentStateSql(whenEmpty: "failed" | "missing"): string {
  return `CASE WHEN content_key IS NULL THEN '${whenEmpty}' WHEN json_extract(content_details,'$.completeness')='unverified' OR coalesce(json_array_length(json_extract(content_details,'$.issues')),0)>0 THEN 'partial' ELSE 'ready' END`;
}
