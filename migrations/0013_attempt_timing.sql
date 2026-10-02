-- FAC-48: per-attempt timing for Activity and the adapter for telemetry.
ALTER TABLE jobs ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE jobs ADD COLUMN attempt_budget_ms INTEGER;
ALTER TABLE jobs ADD COLUMN adapter TEXT;
