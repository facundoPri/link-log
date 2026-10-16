-- Rollback of 0014_unique_library_id.sql (run before 0013/0012 rollbacks).
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0014_unique_library_id.down.sql
DROP INDEX IF EXISTS user_settings_library_id;
DELETE FROM d1_migrations WHERE name='0014_unique_library_id.sql';
