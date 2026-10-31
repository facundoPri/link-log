// Observable library state for tests that must not look inside the database.
import type { client } from "./env";

export type LibraryView = {
  links: { id: string; url: string }[];
  batches: { id: string; kind: string; config: string; total: number; active: number; cancelled: number }[];
};
type Who = { cookie: string };

/** What GET /api/library shows the user: their Links and Activity batches. */
export const libraryOf = async (call: ReturnType<typeof client>, who: Who) => (await (await call("/api/library", { cookie: who.cookie })).json()) as LibraryView;

/** Quota used right now, as Settings shows it (GET /api/usage/summary). */
export async function quotaUsed(call: ReturnType<typeof client>, who: Who) {
  const { quotas } = (await (await call("/api/usage/summary", { cookie: who.cookie })).json()) as { quotas: { links: { used: number }; jobs: { used: number } } };
  return { links: quotas.links.used, jobs: quotas.jobs.used };
}
