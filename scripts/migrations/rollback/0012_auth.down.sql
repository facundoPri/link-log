-- Rollback of 0012_auth.sql. OPTIONAL: leaving the auth tables in place is harmless for code from
-- before FAC-40, and batches/browser_requests/browser_groups keep a nullable user_id that references
-- "user" after 0013_ownership.down.sql. Prefer restoring the pre-migration backup. If you run it
-- anyway, do it only after 0026_api_keys.down.sql and 0013_ownership.down.sql. Deletes every account, session and verification
-- token; the library is untouched.
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0012_auth.down.sql
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS app_rate_limits;
DROP TABLE IF EXISTS "rateLimit";
DROP TABLE IF EXISTS "verification";
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "user";
DELETE FROM d1_migrations WHERE name='0012_auth.sql';
