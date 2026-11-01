// The API key plugin's own session routes, as Settings calls them through Better Auth's client.
import type { client } from "./env";

type Who = { cookie: string };
type Init = { origin?: string | null };
export type PluginKey = {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: string;
  lastRequest: string | null;
  referenceId: string;
};

export const keyRoutes = (call: ReturnType<typeof client>, who: Who) => ({
  create: (body: unknown, init: Init = {}) => call("/api/auth/api-key/create", { cookie: who.cookie, body, ...init }),
  list: () => call("/api/auth/api-key/list", { cookie: who.cookie }),
  get: (id: string) => call(`/api/auth/api-key/get?id=${encodeURIComponent(id)}`, { cookie: who.cookie }),
  update: (body: unknown, init: Init = {}) => call("/api/auth/api-key/update", { cookie: who.cookie, body, ...init }),
  remove: (keyId: string, init: Init = {}) => call("/api/auth/api-key/delete", { cookie: who.cookie, body: { keyId }, ...init }),
  revoke: (keyId: string) => call("/api/auth/api-key/update", { cookie: who.cookie, body: { keyId, enabled: false } }),
  enable: (keyId: string) => call("/api/auth/api-key/update", { cookie: who.cookie, body: { keyId, enabled: true } }),
  /** The user's keys as the list route answers them. */
  keys: async () => ((await (await call("/api/auth/api-key/list", { cookie: who.cookie })).json()) as { apiKeys: PluginKey[] }).apiKeys,
});
