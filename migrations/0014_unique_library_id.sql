-- A Browser library id identifies one account's results in the extension (its library scope):
-- it is never shared. Before this index, re-running the local adjudication could hand the legacy
-- id to a second user; the first holder keeps it and later copies are dropped (those users get a
-- fresh id the next time they open Browser).
-- Rollback: scripts/migrations/rollback/0014_unique_library_id.down.sql.
DELETE FROM user_settings WHERE key='library_id'
  AND rowid NOT IN (SELECT min(rowid) FROM user_settings WHERE key='library_id' GROUP BY value);
CREATE UNIQUE INDEX user_settings_library_id ON user_settings(value) WHERE key='library_id';
