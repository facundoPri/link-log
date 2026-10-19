-- FAC-54: the classified answer of a job's Jev call, recorded under its claim before anything else is awaited,
-- so a retried attempt recovers it (an account error still stops the batch) instead of reporting an interruption.
ALTER TABLE jobs ADD COLUMN jev_outcome TEXT;
