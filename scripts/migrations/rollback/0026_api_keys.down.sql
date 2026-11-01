-- Rollback of 0026_api_keys.sql. Deletes every API key: integrations using one stop authenticating
-- and need a new key after re-applying the migration. Run it before 0012_auth.down.sql (the table
-- references "user"). The library and Activity are untouched.
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0026_api_keys.down.sql
DROP TABLE IF EXISTS "apikey";
DELETE FROM d1_migrations WHERE name='0026_api_keys.sql';
