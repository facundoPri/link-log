import { defaultKeyHasher } from "@better-auth/api-key";

// The only raw SQL on the API key plugin's table (migrations/0026_api_keys.sql); everything else
// goes through the plugin. It couples to the plugin's columns: "key" holds the SHA-256 hash of the
// secret (defaultKeyHasher) and is indexed, "enabled" is 1 for an active key and 0 once revoked,
// and "referenceId" is the owning user. If the plugin changes any of them, they change here.

export type KeyState = { enabled: boolean };

/** The key with this secret, or null when none exists. Throws when the lookup itself fails. */
export async function findBySecret(db: D1Database, secret: string): Promise<KeyState | null> {
  const row = await db.prepare('SELECT enabled FROM apikey WHERE "key"=?').bind(await defaultKeyHasher(secret)).first<{ enabled: number | null }>();
  return row && { enabled: row.enabled === 1 };
}

/** The user's own key with this id (name and state; when it was last turned off), or null. */
export async function findOwn(db: D1Database, keyId: string, userId: string) {
  const row = await db.prepare("SELECT name,enabled,updatedAt FROM apikey WHERE id=? AND \"referenceId\"=?")
    .bind(keyId, userId)
    .first<{ name: string | null; enabled: number | null; updatedAt: string }>();
  return row && { name: row.name, enabled: row.enabled === 1, updatedAt: row.updatedAt };
}

/** How many active keys the user holds, in one query. */
export async function activeCount(db: D1Database, userId: string) {
  const row = await db.prepare('SELECT count(*) AS n FROM apikey WHERE "referenceId"=? AND enabled=1').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Turns the key off only if it is still on, stamping `at` as the update time; false when it was already off. */
export async function claimRevoke(db: D1Database, keyId: string, userId: string, at: string) {
  const { meta } = await db.prepare('UPDATE apikey SET enabled=0,updatedAt=? WHERE id=? AND "referenceId"=? AND enabled=1').bind(at, keyId, userId).run();
  return meta.changes > 0;
}

/** Removes a key row. Only for a key whose secret was never given to anyone. */
export async function remove(db: D1Database, keyId: string, userId: string) {
  await db.prepare('DELETE FROM apikey WHERE id=? AND "referenceId"=?').bind(keyId, userId).run();
}
