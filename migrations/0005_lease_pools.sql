-- Separate concurrency pools: heavy browser extractions vs. light Jev calls.
ALTER TABLE provider_leases ADD COLUMN pool TEXT NOT NULL DEFAULT 'browser';
