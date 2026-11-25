// FAC-184: links pasted into the ⌘K palette are saved through /import with the tags picked there, one tag set for
// every link, new or already saved, in a fixed number of statements.
import { afterEach, expect, test } from "bun:test";
import { resetClock, setup } from "./worker-harness";
import type { Library } from "../src/types";

afterEach(resetClock);

const tagsOf = (library: Library, url: string) =>
  library.links.find((l) => l.url === url)?.tags.map((t) => t.name).sort();

test("tags picked while pasting apply to every imported link, new or already saved", async () => {
  const s = await setup();
  await s.api("/links", "POST", { url: "https://tags.example/old", tags: ["kept"] });
  const urls = ["https://tags.example/old", "https://tags.example/a", "https://tags.example/b"];
  const res = await s.api("/import", "POST", { urls, tags: ["Later", "reading"] });
  expect([res.status, res.data.imported, res.data.duplicates]).toEqual([200, 2, 1]);
  const library = res.data as Library;
  expect(tagsOf(library, "https://tags.example/a")).toEqual(["later", "reading"]);
  expect(tagsOf(library, "https://tags.example/b")).toEqual(["later", "reading"]);
  // Tags are added, never replaced.
  expect(tagsOf(library, "https://tags.example/old")).toEqual(["kept", "later", "reading"]);
  expect(library.tags.map((t) => t.name).sort()).toEqual(["kept", "later", "reading"]);
});

test("without tags an import tags nothing; bad tags are refused before anything is saved", async () => {
  const s = await setup();
  const plain = await s.api("/import", "POST", { urls: ["https://tags.example/plain"] });
  expect(tagsOf(plain.data as Library, "https://tags.example/plain")).toEqual([]);
  const bad = await s.api("/import", "POST", { urls: ["https://tags.example/refused"], tags: ["x".repeat(41)] });
  expect(bad.status).toBe(400);
  const library = (await s.api("/library")).data as Library;
  expect(library.links.some((l) => l.url === "https://tags.example/refused")).toBe(false);
});

test("one import tags all 100 links of a full batch", async () => {
  const s = await setup();
  const urls = Array.from({ length: 100 }, (_, i) => `https://tags.example/many/${i}`);
  const res = await s.api("/import", "POST", { urls, tags: ["bulk"] });
  expect(res.data.imported).toBe(100);
  expect((res.data as Library).links.filter((l) => l.tags.some((t) => t.name === "bulk")).length).toBe(100);
});
