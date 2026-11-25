import { expect, it } from "bun:test";
import { privatePaths } from "../scripts/check-private-paths";

it("flags files under private folders and env files", () => {
  const files = ["local/notes.md", "tests/fixtures/private/a.json", ".profiles/x/Default", "qa/out/v.webm", ".dev.vars", "apps/landing/.dev.vars", "apps/x/.env.local", "src/ok.ts", ".dev.vars.example", "src/local/ok.ts", ".env.example", "docs/agents/domain.md"];
  expect(privatePaths(files)).toEqual(["local/notes.md", "tests/fixtures/private/a.json", ".profiles/x/Default", "qa/out/v.webm", ".dev.vars", "apps/landing/.dev.vars", "apps/x/.env.local"]);
});
