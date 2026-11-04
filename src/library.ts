import { useCallback } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Library } from "./types";

// How library data stays current:
// - A view reads the cache, shows it right away and revalidates when it opens and when the window
//   regains focus or the network comes back.
// - The library polls only while work is in flight (`busy`).
// - A response that carries the library is written with `writeLibrary`. An action that starts work
//   without returning the library invalidates it once the server accepts the work, so its batch
//   shows in Activity and polling starts.
export const libraryKey = ["library"] as const;
export const POLL_MS = 1800;

export const emptyLibrary: Library = {
  links: [],
  tags: [],
  lenses: [],
  batches: [],
  capabilities: { markdown: false, jev: false, provider: "typesafe" },
};

/** Work is in flight while a link is processing or a batch has active jobs. */
export const busy = (library: Library | undefined) =>
  !!library && (library.links.some((l) => l.processing) || library.batches.some((b) => b.active > 0));

/** One cache per signed-in account; it is dropped with the account. */
export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The whole library from `GET /api/library`. It polls only while work is in flight. */
export function useLibrary() {
  return useQuery({
    queryKey: libraryKey,
    queryFn: () => api<Library>(),
    refetchInterval: (query) => (busy(query.state.data) ? POLL_MS : false),
  });
}

/** Writes a library a mutation returned. In-flight GETs are cancelled first, so an older response can't overwrite it. */
export function writeLibrary(client: QueryClient, library: Library) {
  void client.cancelQueries({ queryKey: libraryKey });
  client.setQueryData(libraryKey, library);
}

export function useWriteLibrary() {
  const client = useQueryClient();
  return useCallback((library: Library) => writeLibrary(client, library), [client]);
}

/** For responses that don't carry the library: fetch it again, which also starts polling for new work. */
export function useInvalidateLibrary() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: libraryKey }), [client]);
}
