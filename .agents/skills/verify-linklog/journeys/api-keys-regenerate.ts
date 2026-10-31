// api-keys-regenerate: regenerate an API key from Settings (new secret shown once, old key revoked and
// still listed), hit the cap of 10 active keys when creating, and confirm Demo B cannot regenerate it.
import type { Journey } from "../scripts/journey";

type Key = { id: string; name: string; status: string };

export default (async ({ page, api, apiAs, step, check, shot, aria, note }) => {
  const name = `Regen ${Date.now() % 100000}`;
  const keys = page.getByRole("region", { name: "API keys" });
  const row = (n: string) => keys.getByRole("listitem").filter({ hasText: n });
  const list = async () => (await api.get("/api-keys")).apiKeys as Key[];

  await step("Create a key to regenerate");
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await keys.getByLabel("Name").fill(name);
  await keys.getByRole("button", { name: "Create key" }).click();
  const first = await check("The first secret is shown", async () => (await keys.getByLabel("New API key").textContent())?.match(/^lk_[A-Za-z]{40,}$/)?.[0]);
  await keys.getByRole("button", { name: "Done" }).click();
  const original = await check("API: the key is listed as active", async () => (await list()).find((k) => k.name === name && k.status === "active"));

  await step("Regenerate it");
  await row(name).getByRole("button", { name: "Regenerate" }).click();
  const confirm = page.getByRole("alertdialog");
  await check("Confirmation names the key and says the old one stops working", async () =>
    (await confirm.getByText(`Regenerate “${name}”?`).isVisible()) && (await confirm.getByText(/stops working immediately/).isVisible()));
  await shot("01-regenerate-confirm");
  await confirm.getByRole("button", { name: "Regenerate" }).click();
  const second = await check("A new lk_ secret is shown once, different from the first", async () => {
    const s = (await keys.getByLabel("New API key").textContent()) ?? "";
    return /^lk_[A-Za-z]{40,}$/.test(s) && s !== first && s;
  });
  await check("The notice says the old key no longer works", () => keys.getByText(/The old key no longer works/).isVisible());
  await check("Same name now appears twice: one Active, one Revoked", async () =>
    (await row(name).count()) === 2 && (await row(name).filter({ hasText: "Active" }).count()) === 1 && (await row(name).filter({ hasText: "Revoked" }).count()) === 1);
  await shot("02-regenerated");
  await check("API: new key active, old key revoked, secret not in the list", async () => {
    const r = await api.get("/api-keys");
    const named = (r.apiKeys as Key[]).filter((k) => k.name === name);
    return named.length === 2 && named.find((k) => k.id === original.id)?.status === "revoked" && named.filter((k) => k.status === "active").length === 1 && !JSON.stringify(r).includes(second);
  });
  await page.reload();
  await check("After a reload the secret is gone and both keys stay listed", async () =>
    (await row(name).count()) === 2 && !(await page.content()).includes(second));

  await step("Fill the account to 10 active keys, then try to create an 11th");
  const active = (await list()).filter((k) => k.status === "active").length;
  for (let i = active; i < 10; i++) await api.send("POST", "/api-keys", { name: `Filler ${i}` });
  await page.reload();
  await check("API: exactly 10 active keys", async () => (await list()).filter((k) => k.status === "active").length === 10);
  await keys.getByLabel("Name").fill("One too many");
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("A clear message explains the cap", () => keys.getByRole("alert").getByText("You have 10 active API keys. Revoke one to create another.").isVisible());
  await shot("03-cap-message");
  await check("No 11th key was created", async () => (await list()).filter((k) => k.status === "active").length === 10);

  await step("At 10, regenerating still works because it replaces a key");
  await row(name).filter({ hasText: "Active" }).getByRole("button", { name: "Regenerate" }).click();
  await confirm.getByRole("button", { name: "Regenerate" }).click();
  await check("A third secret is shown", async () => /^lk_[A-Za-z]{40,}$/.test((await keys.getByLabel("New API key").textContent()) ?? ""));
  await check("API: still 10 active keys", async () => (await list()).filter((k) => k.status === "active").length === 10);
  await shot("04-regenerated-at-10");
  const current = (await list()).find((k) => k.name === name && k.status === "active")!;

  await step("Revoking one allows creating again");
  const filler = (await list()).find((k) => k.name.startsWith("Filler") && k.status === "active")!;
  await row(filler.name).filter({ hasText: "Active" }).getByRole("button", { name: "Revoke" }).click();
  await confirm.getByRole("button", { name: "Revoke" }).click();
  await check("The filler shows Revoked", () => row(filler.name).filter({ hasText: "Revoked" }).first().isVisible());
  await keys.getByLabel("Name").fill("Fits now");
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("The new key is created and listed", () => row("Fits now").getByText("Active").isVisible());
  await check("The cap message is gone", async () => (await keys.getByRole("alert").count()) === 0);
  await aria("05-after-create");
  await shot("05-after-create");

  await step("Demo B cannot regenerate Demo A's key");
  const foreign = await apiAs(1).send("POST", `/api-keys/${current.id}/regenerate`, {}).then(() => "ok", (e: Error) => e.message);
  await check("Demo B regenerating Demo A's key answers 404", () => foreign.includes("→ 404"));
  await check("Demo A's key is untouched", async () => (await list()).find((k) => k.id === current.id)?.status === "active");
  await note("keys", { original, current, foreignRegenerate: foreign });
}) satisfies Journey;
