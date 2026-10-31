// FAC-44 round 6 UI check. An unconfirmed regenerate (D1 trigger blocks the old key's revoke): the response
// says oldKey.status "unconfirmed", the alert names the old prefix, exactly the old row carries "Revoke pending"
// (also after Done), revoking that row makes the old key 401 while the new key keeps working. A normal
// regenerate answers "revoked" with no badge. A regenerate refused with 409 (key revoked behind the page)
// refetches the list so the row reads Revoked without a reload.
// Run: bun .agents/skills/verify-linklog/scripts/verify.ts run <this file>
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "/Users/facundopri/orca/workspaces/link-log/fac-44-url-upload";
const d1 = () => {
  const run = readFileSync(join(REPO, ".cache/verify-linklog/current"), "utf8").trim();
  const dir = join(run.startsWith("/") ? run : join(REPO, run), "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
  return new Database(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!));
};

export default async ({ page, api, ui, fixture, step, check, shot, aria, note }: any) => {
  const stamp = Date.now() % 100000;
  const name = `Stuck R6 ${stamp}`;
  const plain = `Plain R6 ${stamp}`;
  const stale = `Stale R6 ${stamp}`;
  const keys = page.getByRole("region", { name: "API keys" });
  const row = (n: string) => keys.getByRole("listitem").filter({ hasText: n });
  const secretText = async () => ((await keys.getByLabel("New API key").textContent()) ?? "").trim();
  const submit = async (secret: string, path: string) => {
    const r = await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls: [fixture("article", path)] }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const regenerateInUi = async (n: string) => {
    const response = page.waitForResponse((r: any) => r.url().endsWith("/regenerate") && r.request().method() === "POST");
    await row(n).getByRole("button", { name: "Regenerate" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Regenerate" }).click();
    const r = await response;
    return { status: r.status(), body: await r.json().catch(() => null) };
  };

  await step("Create the key to get stuck, and block its revoke in D1");
  const old = await api.send("POST", "/api-keys", { name });
  const db = d1();
  db.exec(`CREATE TRIGGER r6_stuck BEFORE UPDATE OF enabled ON apikey WHEN old.id = '${old.apiKey.id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  let regen: any, newPrefix = "", newSecret = "";
  try {
    await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await check("The key is listed Active with its prefix", async () => (await row(name).getByText("Active").isVisible()) && (await row(name).getByText(`${old.apiKey.prefix}…`).isVisible()));

    await step("Regenerate it in the UI while the revoke is blocked");
    regen = await regenerateInUi(name);
    await note("unconfirmed-regenerate-response", { status: regen.status, oldKey: regen.body?.oldKey, apiKey: regen.body?.apiKey });
    await check("Response: 201, oldKey { id: old id, status: unconfirmed }", () =>
      regen.status === 201 && JSON.stringify(regen.body.oldKey) === JSON.stringify({ id: old.apiKey.id, status: "unconfirmed" }));
    newPrefix = regen.body.apiKey.prefix as string;
    newSecret = await check("The new secret is shown and matches the response", async () => { const s = await secretText(); return s === regen.body.secret && s; });
    await check("Alert text names the old key's prefix", async () =>
      (await keys.getByRole("alert").textContent())?.trim() === `The old key (${old.apiKey.prefix}…) may still work. Revoke it now.`);
    await check("No claim that the old key stopped working", async () => (await keys.getByText(/The old key no longer works/).count()) === 0);
    await check("Two rows by name, both Active", async () => (await row(name).count()) === 2 && (await row(name).filter({ hasText: "Active" }).count()) === 2);
    await check("Exactly one Revoke pending badge in the whole list, on the row with the old prefix, not the new", async () =>
      (await keys.getByText("Revoke pending", { exact: true }).count()) === 1
      && (await row(name).filter({ hasText: "Revoke pending" }).filter({ hasText: `${old.apiKey.prefix}…` }).count()) === 1
      && (await row(name).filter({ hasText: "Revoke pending" }).filter({ hasText: `${newPrefix}…` }).count()) === 0
      && newPrefix !== old.apiKey.prefix);
    await page.waitForTimeout(300);
    await row(name).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot("B1-unconfirmed-alert-and-badge");
    await aria("B1-unconfirmed-alert-and-badge");

    await step("Dismiss the secret with Done");
    await keys.getByRole("button", { name: "Done" }).click();
    await check("Alert and secret are gone", async () => (await keys.getByRole("alert").count()) === 0 && (await keys.getByLabel("New API key").count()) === 0);
    await check("Badge still on exactly the old row after Done (and after the list refetch)", async () => {
      await page.waitForTimeout(500);
      return (await keys.getByText("Revoke pending", { exact: true }).count()) === 1 && (await row(name).filter({ hasText: "Revoke pending" }).filter({ hasText: `${old.apiKey.prefix}…` }).count()) === 1;
    });
    await shot("B2-badge-after-done");
    const oldStill = await submit(old.secret, "r6-old-still");
    await check("Old key still authenticates before it is revoked (202)", () => oldStill.status === 202);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS r6_stuck");
    db.close();
  }

  await step("Revoke the pending row by hand");
  await row(name).filter({ hasText: "Revoke pending" }).getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await check("UI: no Revoke pending badge; old row Revoked, new row Active", async () =>
    (await keys.getByText("Revoke pending", { exact: true }).count()) === 0
    && (await row(name).filter({ hasText: `${old.apiKey.prefix}…` }).filter({ hasText: "Revoked" }).count()) === 1
    && (await row(name).filter({ hasText: `${newPrefix}…` }).filter({ hasText: "Active" }).count()) === 1);
  const listed = (await api.get("/api-keys")).apiKeys.filter((k: any) => k.name === name);
  await note("keys-after-revoke", listed);
  await check("API list: old revoked, new active", () =>
    listed.find((k: any) => k.id === old.apiKey.id)?.status === "revoked" && listed.find((k: any) => k.id === regen.body.apiKey.id)?.status === "active");
  const oldAfter = await submit(old.secret, "r6-old-after");
  const newAfter = await submit(newSecret, "r6-new-after");
  await note("after-revoke-submits", { old: oldAfter, new: newAfter });
  await check("Old key 401", () => oldAfter.status === 401);
  await check("New key 202 created", () => newAfter.status === 202 && newAfter.body?.results?.[0]?.status === "created");
  await page.reload();
  await check("After reload: no badge, old Revoked, new Active", async () =>
    (await keys.getByText("Revoke pending", { exact: true }).count()) === 0
    && (await row(name).filter({ hasText: `${old.apiKey.prefix}…` }).filter({ hasText: "Revoked" }).count()) === 1
    && (await row(name).filter({ hasText: `${newPrefix}…` }).filter({ hasText: "Active" }).count()) === 1);
  await row(name).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot("B3-after-revoke");

  await step("Normal regenerate: revoked status, no badge");
  await keys.getByLabel("Name").fill(plain);
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("Plain key created", () => row(plain).getByText("Active").isVisible());
  await keys.getByRole("button", { name: "Done" }).click();
  const normal = await regenerateInUi(plain);
  await note("normal-regenerate-response", { status: normal.status, oldKey: normal.body?.oldKey });
  const plainOldId = (await api.get("/api-keys")).apiKeys.find((k: any) => k.name === plain && k.status === "revoked")?.id;
  await check("Response: 201, oldKey { id: old id, status: revoked }", () => normal.status === 201 && normal.body.oldKey?.status === "revoked" && normal.body.oldKey.id === plainOldId);
  await check("No alert and no Revoke pending badge anywhere; one Active + one Revoked row", async () => {
    await page.waitForTimeout(500);
    return (await keys.getByRole("alert").count()) === 0 && (await keys.getByText("Revoke pending", { exact: true }).count()) === 0
      && (await row(plain).filter({ hasText: "Active" }).count()) === 1 && (await row(plain).filter({ hasText: "Revoked" }).count()) === 1;
  });
  await shot("B4-normal-regenerate-no-badge");
  await keys.getByRole("button", { name: "Done" }).click();

  await step("Regenerate a key revoked behind the page: 409, list refetched");
  const st = await api.send("POST", "/api-keys", { name: stale });
  await page.reload();
  await check("Stale key shows Active", () => row(stale).getByText("Active").isVisible());
  await api.send("POST", `/api-keys/${st.apiKey.id}/revoke`, {});
  const refused = await regenerateInUi(stale);
  await note("stale-regenerate-response", refused);
  await check("Response: 409 api_key_revoked", () => refused.status === 409 && refused.body?.code === "api_key_revoked");
  await check("Without a reload, the row now reads Revoked, has no Regenerate, no badge, no new row", async () =>
    (await row(stale).count()) === 1 && (await row(stale).getByText("Revoked").isVisible()) && (await row(stale).getByRole("button", { name: "Regenerate" }).count()) === 0
    && (await keys.getByText("Revoke pending", { exact: true }).count()) === 0);
  await shot("B5-409-refetched");
};
