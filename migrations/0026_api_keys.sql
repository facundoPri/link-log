-- Better Auth 1.7.7 API key plugin (@better-auth/api-key 1.7.7) table. Generated with
-- scripts/auth/print-schema.ts (getMigrations) and reviewed; the only change is the foreign key
-- on "referenceId": keys here are always user-owned, so they go with their user like sessions do.
-- "key" holds the SHA-256 hash, never the secret; "start" is the visible prefix shown in Settings.
-- Rollback: scripts/migrations/rollback/0026_api_keys.down.sql.
CREATE TABLE "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null references "user" ("id") on delete cascade, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);
CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
