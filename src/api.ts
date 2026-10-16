import type { Library } from "./types";
import { announceUnauthorized } from "./auth-client";
export async function api<T = Library & { duplicate?: boolean; id?: string }>(
  path = "/library",
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as Library & {
    duplicate?: boolean;
    id?: string;
    error?: string;
  };
  if (response.status === 401) announceUnauthorized();
  if (!response.ok)
    throw new Error(data.error || "Something went wrong.");
  return data as T;
}
