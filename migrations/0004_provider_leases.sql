-- Bound provider concurrency across workflows, not only Queue consumers.
CREATE TABLE provider_leases (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
