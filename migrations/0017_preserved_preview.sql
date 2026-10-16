-- No backfill: existing metadata may already describe an access wall.
ALTER TABLE links ADD COLUMN original_metadata TEXT CHECK(original_metadata IS NULL OR json_valid(original_metadata));
ALTER TABLE links ADD COLUMN metadata_error TEXT;
