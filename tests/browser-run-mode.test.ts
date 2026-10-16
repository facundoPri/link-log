import { expect, test } from "bun:test";
import { browserRunAvailable, requireBrowserRun } from "../worker/adapters/browser-run";
import { webAdapter } from "../worker/adapters/web";
import { capabilities } from "../worker/store";

test("local-only extraction fails before the unsupported Browser RPC or usage recording", async () => {
  let calls = 0;
  const env = {
    APP_ENV: "local", LOCAL_SERVICES_ONLY: "1",
    BROWSER: { quickAction: () => { calls++; throw new Error('The RPC receiver does not implement the method "quickAction".'); } },
    DB: { prepare: () => { throw new Error("must not record a cloud call"); } },
  } as unknown as Env;
  expect(capabilities(env).markdown).toBe(false);
  await expect(webAdapter.extract!(env, "https://gpui-kit.com/base", { id: "job", batch_id: "batch", link_id: "link" }))
    .rejects.toThrow("use the connected demo");
  expect(calls).toBe(0);
});

test("connected local and deployed Browser bindings stay available", () => {
  for (const APP_ENV of ["local", "test", "preview", "production"]) {
    const env = { APP_ENV, LOCAL_SERVICES_ONLY: APP_ENV === "local" || APP_ENV === "test" ? "0" : "1", BROWSER: {} } as unknown as Env;
    expect(browserRunAvailable(env)).toBe(true);
    expect(() => requireBrowserRun(env)).not.toThrow();
  }
});

test("an absent browser service is never advertised", () => {
  const env = { APP_ENV: "production" } as Env;
  expect(browserRunAvailable(env)).toBe(false);
  expect(() => requireBrowserRun(env)).toThrow("not configured");
});
