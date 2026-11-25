import type { Library } from "./types";
import { announceUnauthorized, authClient } from "./auth-client";

/** The methods that change something on the server. A GET is `apiRead`, which needs a query's signal. */
export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as Library & {
    duplicate?: boolean;
    id?: string;
    error?: string;
  };
  // The body stays on the error for callers that act on its details (like the links a batch skipped).
  if (response.status === 401) announceUnauthorized();
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Something went wrong."), { data });
  return data as T;
}

/**
 * A server read. Only a TanStack Query `queryFn` calls it, with the `signal` the query hands it, so a
 * cancelled or superseded read is aborted instead of running to the end, and the cache holds the only copy.
 */
export const apiRead = <T>(path: string, signal: AbortSignal) => request<T>(path, "GET", undefined, signal);

/** A server write (a mutation). It takes no signal: a query never cancels a write the user started. */
export const api = <T = Library & { duplicate?: boolean; id?: string }>(path: string, method: WriteMethod, body?: unknown) =>
  request<T>(path, method, body);

/** The API keys list, read through the auth client. Like `apiRead`, only a `queryFn` calls it, with its signal. */
export const apiKeysRead = (signal: AbortSignal) => authClient.apiKey.list({ fetchOptions: { signal } });
