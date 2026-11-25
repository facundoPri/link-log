import { expect, test } from "bun:test";
import { Glob } from "bun";

// A fake extension bridge that answers hello with a literal protocol rots silently when
// PROTOCOL_VERSION moves (bulk-open did after #34), and CI runs only the journeys that import it
// (browser-journeys.yml). Import it instead.
test("no verify-linklog journey answers with a literal protocol number", async () => {
  const offenders: string[] = [];
  let scanned = 0;
  for await (const path of new Glob(".agents/skills/verify-linklog/journeys/*.ts").scan({ dot: true })) {
    scanned++;
    const lines = (await Bun.file(path).text()).split("\n");
    lines.forEach((line, i) => {
      if (/\bprotocol:\s*\d/.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(scanned).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
