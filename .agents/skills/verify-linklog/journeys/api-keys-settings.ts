// api-keys-settings: open Settings from the user menu, create a named API key and see its secret
// once, revoke a key, and confirm from a reload, the API and Demo B that keys stay with their owner.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, apiAs, step, check, shot, aria, note }) => {
  const name = `Shortcuts ${Date.now() % 100000}`;

  await step("Open Settings from the user menu");
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await shot("01-user-menu");
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await check("Settings page is shown at /settings", async () => (await page.getByRole("heading", { name: "Settings" }).isVisible()) && page.url().endsWith("/settings"));
  const account = page.getByRole("region", { name: "Account" });
  await check("Account shows the email", () => account.getByText("demo-a@linklog.test").isVisible());
  await check("Account offers sign out", () => account.getByRole("button", { name: "Sign out" }).isVisible());
  await shot("02-settings");

  await step("Create a named API key");
  const keys = page.getByRole("region", { name: "API keys" });
  await keys.getByLabel("Name").fill(name);
  await keys.getByRole("button", { name: "Create key" }).click();
  const secretBox = keys.getByLabel("New API key");
  const secret = await check("The full lk_ secret is shown once", async () => {
    const s = (await secretBox.textContent()) ?? "";
    return /^lk_[A-Za-z]{40,}$/.test(s) && s;
  });
  await check("The new key is listed as active", () => keys.getByRole("listitem").filter({ hasText: name }).getByText("Active").isVisible());
  await shot("03-key-created");
  const listed = await check("API: the list has the key with its prefix and never the secret", async () => {
    const r = await api.get("/api-keys");
    const key = r.apiKeys.find((k: { name: string }) => k.name === name);
    return key && !JSON.stringify(r).includes(secret) && secret.startsWith(key.prefix) && key;
  });
  await check("Row shows the visible prefix, creation date and no last use", async () => {
    const row = keys.getByRole("listitem").filter({ hasText: name });
    return (await row.getByText(`${listed.prefix}…`).isVisible()) && (await row.getByText("Never used").isVisible()) && (await row.getByText(/^Created /).isVisible());
  });

  await step("Dismiss the secret: it is not shown again after a reload");
  await keys.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await check("Settings loads directly at /settings", () => page.getByRole("heading", { name: "Settings" }).isVisible());
  await check("Key is still listed, secret gone", async () =>
    (await keys.getByRole("listitem").filter({ hasText: name }).isVisible()) && !(await page.content()).includes(secret));

  await step("Revoke the key");
  await keys.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Revoke" }).click();
  const confirm = page.getByRole("alertdialog");
  await check("Confirmation names the key", () => confirm.getByText(`Revoke “${name}”?`).isVisible());
  await shot("04-revoke-confirm");
  await confirm.getByRole("button", { name: "Revoke" }).click();
  const revokedRow = keys.getByRole("listitem").filter({ hasText: name });
  await check("Row shows Revoked and no Revoke button", async () =>
    (await revokedRow.getByText("Revoked").isVisible()) && (await revokedRow.getByRole("button", { name: "Revoke" }).count()) === 0);
  await check("API: the key stays listed as revoked", async () =>
    (await api.get("/api-keys")).apiKeys.some((k: { id: string; status: string }) => k.id === listed.id && k.status === "revoked"));
  await page.reload();
  await check("Still revoked after reload", () => keys.getByRole("listitem").filter({ hasText: name }).getByText("Revoked").isVisible());
  await aria("05-after-revoke");
  await shot("05-after-revoke");

  await step("Demo B cannot see or revoke Demo A's keys");
  const b = apiAs(1);
  const bKeys = await b.get("/api-keys");
  await check("Demo B's list does not include Demo A's key", () => !bKeys.apiKeys.some((k: { id: string }) => k.id === listed.id));
  const foreign = await b.send("POST", `/api-keys/${listed.id}/revoke`, {}).then(() => "ok", (e: Error) => e.message);
  await check("Demo B revoking Demo A's key answers 404 like a missing key", () => foreign.includes("→ 404"));
  await note("keys", { listed, demoBKeys: bKeys, foreignRevoke: foreign });

  await step("Back to the library");
  await page.getByRole("button", { name: "Back to library" }).click();
  await check("Library is shown again", async () => (await page.getByRole("button", { name: "Add link" }).first().isVisible()) && new URL(page.url()).pathname === "/");
}) satisfies Journey;
