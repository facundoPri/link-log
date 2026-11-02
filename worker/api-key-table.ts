import { defaultKeyHasher } from "@better-auth/api-key";

// The only raw SQL on the API key plugin's table (migrations/0026_api_keys.sql) besides the usage
// summary's status read; everything else goes through the plugin. It couples to the plugin's
// columns: "key" holds the SHA-256 hash of the secret (defaultKeyHasher) and is indexed, and
// "enabled" is 1 for an active key and 0 once revoked. If the plugin changes either, it changes here.

/**
 * Whether a key with this secret exists and is on, or null when none exists. Throws when the lookup
 * itself fails. verifyApiKey answers an unknown key and a failed read the same way (INVALID_API_KEY),
 * so after that answer the public API reads the row to tell a retryable failure (503) from an
 * invalid key (401). tests/api-keys.test.ts pins this coupling against a key the plugin created.
 */
export async function findBySecret(db: D1Database, secret: string): Promise<{ enabled: boolean } | null> {
  const row = await db.prepare('SELECT enabled FROM apikey WHERE "key"=?').bind(await defaultKeyHasher(secret)).first<{ enabled: number | null }>();
  return row && { enabled: row.enabled === 1 };
}
