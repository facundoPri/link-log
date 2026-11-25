-- Rollback of 0030_deleted_link_titles.sql: drops the index it adds, restoring the 0029 schema. The previous Worker
-- never reads it. Titles the cron already forgot stay forgotten; Activity names those jobs by nothing until the
-- new Worker returns.
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0030_deleted_link_titles.down.sql
DROP INDEX IF EXISTS jobs_deleted_link_title;
DELETE FROM d1_migrations WHERE name='0030_deleted_link_titles.sql';
