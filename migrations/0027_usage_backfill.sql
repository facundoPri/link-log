-- FAC-168: rows stored before their price was known. Browser calls finished before BROWSER_USD_PER_HOUR
-- ($0.09 per browser hour) existed get priced from their recorded browser time. Jev calls refused for
-- exceeding the token window cost nothing, as finishUsage now records them. Interrupted calls have no
-- recorded units: like INTERRUPTED_USAGE, they get the average of their service's finished calls.
UPDATE usage_events SET estimated_usd=browser_ms/3600000.0*0.09
WHERE estimated_usd IS NULL AND provider='cloudflare' AND model IS NULL AND browser_ms IS NOT NULL AND status IN ('done','failed');
UPDATE usage_events SET estimated_usd=0
WHERE estimated_usd IS NULL AND service='jev' AND status='failed' AND input_tokens IS NULL
  AND instr(error,'Jev rejected the content for exceeding its token window')=1;
UPDATE usage_events SET estimated_usd=(SELECT avg(p.estimated_usd) FROM usage_events p WHERE p.service=usage_events.service AND p.status='done' AND p.estimated_usd IS NOT NULL)
WHERE estimated_usd IS NULL AND status='failed' AND error='Provider call interrupted before completion';
