-- Browser jobs are looked up by target (status joins, cancellation, retention).
CREATE INDEX IF NOT EXISTS jobs_target ON jobs(target_id);
