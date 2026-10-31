// api-keys-regenerate-unconfirmed: when the old key cannot be revoked during a regenerate, Settings
// keeps it Active and tells the owner to revoke it, instead of showing it revoked. Fault injection:
// a trigger in this instance's local D1 makes the revoke of one key fail, so both claim attempts
// throw. The old key still verifies (a submission with its secret is accepted) until revoked by hand
// once the trigger is dropped.
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Journey } from "../scripts/journey";

const d1 = () => {
  const root = resolve(import.meta.dir, "../../../..");
  const run = readFileSync(join(root, ".cache/verify-linklog/current"), "utf8").trim();
  const dir = join(root, run, "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
  return new Database(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!));
};

export default (async ({ page, api, ui, fixture, step, check, shot, note }) => {
  const name = `Stuck ${Date.now() % 100000}`;
  const keys = page.getByRole("region", { name: "API keys" });
  const row = (n: string) => keys.getByRole("listitem").filter({ hasText: n });
  const submit = (secret: string) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls: [fixture("pool", "stuck")] }) });

  await step("Create a key and make its revoke fail in the database");
  const old = await api.send("POST", "/api-keys", { name });
  const db = d1();
  db.exec(`CREATE TRIGGER stuck_key BEFORE UPDATE OF enabled ON apikey WHEN old.id = '${old.apiKey.id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await check("The key is listed as Active", () => row(name).getByText("Active").isVisible());

  await step("Regenerate it");
  await row(name).getByRole("button", { name: "Regenerate" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Regenerate" }).click();
  await check("The new secret is shown", async () => /^lk_[A-Za-z]{40,}$/.test((await keys.getByLabel("New API key").textContent()) ?? ""));
  await check("The owner is told to revoke the old key", () => keys.getByRole("alert").getByText("The old key could not be revoked. Revoke it now.").isVisible());
  await check("The notice does not claim the old key stopped working", async () => (await keys.getByText(/The old key no longer works/).count()) === 0);
  await check("Both keys are listed Active", async () => (await row(name).count()) === 2 && (await row(name).filter({ hasText: "Active" }).count()) === 2);
  await shot("01-unconfirmed");
  await check("The old key still authenticates (it was not revoked)", async () => (await submit(old.secret)).status === 202);
  await note("keys", (await api.get("/api-keys")).apiKeys.filter((k: { name: string }) => k.name === name));

  await step("Revoke the old key by hand once the database works again");
  db.exec("DROP TRIGGER stuck_key");
  db.close();
  await row(name).filter({ hasText: "Active" }).last().getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await check("API: the old key is revoked and stops authenticating", async () =>
    (await api.get("/api-keys")).apiKeys.find((k: { id: string }) => k.id === old.apiKey.id)?.status === "revoked" && (await submit(old.secret)).status === 401);
  await shot("02-revoked-by-hand");
}) satisfies Journey;
