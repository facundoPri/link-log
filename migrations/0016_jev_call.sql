-- FAC-54: the one Jev call a job may make. Set (to its usage row id) atomically right before sending;
-- an attempt that can't set it never calls the provider.
ALTER TABLE jobs ADD COLUMN jev_call TEXT;
