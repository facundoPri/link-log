import { defaultKeyHasher } from "@better-auth/api-key";

// The only raw SQL on the API key plugin's table (migrations/0026_api_keys.sql); everything else
// goes through the plugin. It couples to the plugin's columns: "key" holds the SHA-256 hash of the
// secret (defaultKeyHasher) and is indexed, "enabled" is 1 for an active key and 0 once revoked,
// "referenceId" is the owning user, and "metadata" is the plugin's JSON text for caller-defined
// data (a JSON object or null): a revoke claim adds a `replacedBy` field to it, which the plugin
// reads back as ordinary metadata and never interprets. If the plugin changes any of them, they
// change here.

export type KeyState = { enabled: boolean };

/** The key with this secret, or null when none exists. Throws when the lookup itself fails. */
export async function findBySecret(db: D1Database, secret: string): Promise<KeyState | null> {
  const row = await db.prepare('SELECT enabled FROM apikey WHERE "key"=?').bind(await defaultKeyHasher(secret)).first<{ enabled: number | null }>();
  return row && { enabled: row.enabled === 1 };
}

/** The user's own key with this id (name and state), or null. */
export async function findOwn(db: D1Database, keyId: string, userId: string) {
  const row = await db.prepare("SELECT name,enabled FROM apikey WHERE id=? AND \"referenceId\"=?")
    .bind(keyId, userId)
    .first<{ name: string | null; enabled: number | null }>();
  return row && { name: row.name, enabled: row.enabled === 1 };
}

/** How many active keys the user holds, in one query. */
export async function activeCount(db: D1Database, userId: string) {
  const row = await db.prepare('SELECT count(*) AS n FROM apikey WHERE "referenceId"=? AND enabled=1').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Turns the key off, marking it with the id of the key that replaces it (`replacedBy`, in the
 * plugin's metadata object). True when this request owns the revoke: the key was on, or it was
 * already turned off by a claim with the same `replacedBy`. False when it was off for any other
 * reason. SQLite counts matched rows as changed, so repeating the claim after a lost answer says
 * whether the first one landed.
 */
export async function claimRevoke(db: D1Database, keyId: string, userId: string, replacedBy: string) {
  const { meta } = await db
    .prepare(
      `UPDATE apikey SET enabled=0,updatedAt=?1,metadata=json_set(CASE WHEN json_valid(metadata) THEN CASE WHEN json_type(metadata)='object' THEN metadata ELSE '{}' END ELSE '{}' END,'$.replacedBy',?2) WHERE id=?3 AND "referenceId"=?4 AND (enabled=1 OR (json_valid(metadata) AND json_extract(metadata,'$.replacedBy')=?2))`,
    )
    .bind(new Date().toISOString(), replacedBy, keyId, userId)
    .run();
  return meta.changes > 0;
}

/** Removes a key row. Only for a key whose secret was never given to anyone. */
export async function remove(db: D1Database, keyId: string, userId: string) {
  await db.prepare('DELETE FROM apikey WHERE id=? AND "referenceId"=?').bind(keyId, userId).run();
}
