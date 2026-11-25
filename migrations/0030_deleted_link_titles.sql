-- FAC-264: the cron forgets the title a deleted link left on its jobs (jobs.link_title) once their batch finishes.
-- Only jobs of deleted links carry link_title, so this partial index lets the sweep skip every other job.
-- Rollback: scripts/migrations/rollback/0030_deleted_link_titles.down.sql.
CREATE INDEX jobs_deleted_link_title ON jobs(batch_id) WHERE link_title IS NOT NULL;
