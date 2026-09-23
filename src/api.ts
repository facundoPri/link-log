import type { Library } from "./types";
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
  if (!response.ok)
    throw new Error(data.error || "Something went wrong.");
  return data as T;
}
