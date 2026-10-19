-- FAC-53: a job enqueued on a link that already has one waits in D1 (status 'waiting') until the jobs before
-- it settle. Waiting jobs stay outside jobs_active_link, so a link still has at most one queued or running job.
CREATE INDEX jobs_waiting_link ON jobs(link_id, created_at) WHERE status='waiting';
