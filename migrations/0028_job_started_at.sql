-- FAC-193: when the Jev queue consumer started running a job (epoch ms). A job still running long after any
-- consumer invocation could have ended was abandoned by its runner, and the next delivery settles it.
-- The Workflow never sets it.
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
