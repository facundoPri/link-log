import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { batchJobsOptions } from "../src/entities";
import { libraryKey } from "../src/library";

// A row shows "In progress…" from its batch's jobs and its tags and verdicts from the library, two polls on their
// own clocks. When a job finishes, the library must already hold its result before the job leaves "In progress…",
// or the row shows neither for up to a poll.

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

function server(jobStatus: () => string, libraryDown = () => false) {
  const log: string[] = [];
  let tagged = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/batches/b1") {
      const status = jobStatus();
      // The job and its result settle in one transaction.
      if (status === "done") tagged = true;
      log.push(`jobs:${status}`);
      return Response.json({ jobs: [{ id: "j1", link_id: "l1", status, step: status }] });
    }
    if (path === "/api/library") {
      if (libraryDown()) {
        log.push("library:error");
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      log.push(`library:${tagged ? "tagged" : "untagged"}`);
      return Response.json({ links: [{ id: "l1", tags: tagged ? ["topic"] : [] }], batches: [], tags: [] });
    }
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch;
  return log;
}

async function primed(status: () => string, libraryDown?: () => boolean) {
  const log = server(status, libraryDown);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The library query as the app registers it, so a refetch knows how to load it.
  await client.fetchQuery({
    queryKey: libraryKey,
    queryFn: async () => {
      const response = await fetch("/api/library");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
  });
  await client.fetchQuery({ ...batchJobsOptions("b1"), staleTime: 0 });
  return { client, log };
}

test("a job seen finishing is published only after the library holds its result", async () => {
  let status = "running";
  const { client, log } = await primed(() => status);
  status = "done";
  await client.fetchQuery({ ...batchJobsOptions("b1"), staleTime: 0 });
  expect(log).toEqual(["library:untagged", "jobs:running", "jobs:done", "library:tagged"]);
  expect(client.getQueryData<{ links: { tags: string[] }[] }>(libraryKey)!.links[0]!.tags).toEqual(["topic"]);
});

test("a poll where no job finished does not refetch the library", async () => {
  const { client, log } = await primed(() => "running");
  await client.fetchQuery({ ...batchJobsOptions("b1"), staleTime: 0 });
  expect(log).toEqual(["library:untagged", "jobs:running", "jobs:running"]);
});

test("the first load of a batch that already finished does not refetch the library", async () => {
  const { log } = await primed(() => "done");
  expect(log).toEqual(["library:untagged", "jobs:done"]);
});

test("when the library can't be loaded, the job stays in progress until a poll can load its result", async () => {
  let status = "running", down = false;
  const { client, log } = await primed(() => status, () => down);
  status = "done";
  down = true;
  const held = await client.fetchQuery({ ...batchJobsOptions("b1"), staleTime: 0 });
  expect(held.map((j) => j.status)).toEqual(["running"]);
  down = false;
  const settled = await client.fetchQuery({ ...batchJobsOptions("b1"), staleTime: 0 });
  expect(settled.map((j) => j.status)).toEqual(["done"]);
  expect(log).toEqual(["library:untagged", "jobs:running", "jobs:done", "library:error", "jobs:done", "library:tagged"]);
});
