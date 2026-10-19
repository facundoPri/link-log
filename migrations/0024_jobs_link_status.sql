-- A link's active jobs (queued, running or waiting) are read on every library poll and enqueue. The partial
-- indexes jobs_active_link and jobs_waiting_link can't serve the three statuses together.
CREATE INDEX IF NOT EXISTS jobs_link_status ON jobs(link_id, status);
