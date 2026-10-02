-- Rollback of 0010_auth.sql. Run only after 0011_ownership.down.sql (links no longer reference
-- "user"). Deletes every account, session and verification token; the library is untouched.
--   bunx wrangler d1 execute linklog --local [--persist-to DIR] --file scripts/migrations/rollback/0010_auth.down.sql
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS app_rate_limits;
DROP TABLE IF EXISTS "rateLimit";
DROP TABLE IF EXISTS "verification";
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "user";
DELETE FROM d1_migrations WHERE name='0010_auth.sql';
