// api-keys-revoked-section: revoked API keys live in a closed "Revoked keys (N)" section, scrollable
// when long, each with Enable and Delete; active keys have Revoke and Delete. Enabling makes the key
// authenticate again, deleting asks for confirmation, removes the key for good and leaves its Links in
// Usage under the stored name, marked Deleted. Ends with the clear 400 for a body that is not valid JSON.
// Rerunnable: key names are unique per run and counts are read as deltas.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, ui, fixture, step, check, shot, aria, note }) => {
  const stamp = Date.now() % 100000;
  const [keep, old, again] = [`Keep ${stamp}`, `Old ${stamp}`, `Again ${stamp}`];
  const keys = page.getByRole("region", { name: "API keys" });
  const active = keys.getByRole("list", { name: "API keys" });
  const section = keys.locator("details");
  const summary = section.locator("summary");
  const confirm = page.getByRole("alertdialog");
  const create = (name: string) => api.send("POST", "/auth/api-key/create", { name });
  const listOf = async () => (await api.get("/auth/api-key/list")).apiKeys as { id: string; name: string; enabled: boolean }[];
  const submit = (secret: string, urls: string[]) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
  // The keys section sits below the fold: scroll to the bottom so the screenshots show it.
  const bottom = () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const revokedCount = async () => Number(/\((\d+)\)/.exec((await summary.textContent()) ?? "")?.[1] ?? 0);

  await step("Set up: three keys, one of them used for a Link");
  const [kKeep, kOld, kAgain] = [await create(keep), await create(old), await create(again)];
  await check("API: the old key submits a Link", async () => (await submit(kOld.key, [fixture("pool", "old")])).status === 202);

  await step("Open Settings: all three are active, so there is no Revoked keys section for them yet");
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  for (const name of [keep, old, again])
    await check(`${name} is listed as active with Revoke and Delete`, async () => {
      const row = active.getByRole("listitem").filter({ hasText: name });
      return (await row.getByRole("button", { name: "Revoke" }).isVisible()) && (await row.getByRole("button", { name: "Delete" }).isVisible());
    });
  const before = (await section.count()) ? await revokedCount() : 0;

  await step("Revoke two keys from the active list");
  for (const name of [old, again]) {
    await active.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Revoke" }).click();
    await confirm.getByRole("button", { name: "Revoke" }).click();
    await check(`${name} left the active list`, async () => (await active.getByText(name).count()) === 0);
  }
  await check("The Revoked keys section shows the new count and is closed by default", async () =>
    (await revokedCount()) === before + 2 && (await section.evaluate((d: HTMLDetailsElement) => !d.open)));
  await check("The closed section hides its rows", async () => !(await keys.getByRole("list", { name: "Revoked API keys" }).isVisible()));
  await bottom();
  await shot("01-revoked-section-closed");

  await step("Open the section: revoked rows have Enable and Delete and no Revoke; the list scrolls");
  await summary.click();
  const revoked = keys.getByRole("list", { name: "Revoked API keys" });
  await check("Both revoked keys are listed with Enable and Delete", async () => {
    for (const name of [old, again]) {
      const row = revoked.getByRole("listitem").filter({ hasText: name });
      if (!((await row.getByRole("button", { name: "Enable" }).isVisible()) && (await row.getByRole("button", { name: "Delete" }).isVisible()) && (await row.getByRole("button", { name: "Revoke" }).count()) === 0)) return false;
    }
    return true;
  });
  await check("The revoked list is scrollable (bounded height, vertical scroll)", () =>
    revoked.evaluate((el) => getComputedStyle(el).overflowY === "auto" && getComputedStyle(el).maxHeight !== "none"));
  await bottom();
  await shot("02-revoked-section-open");
  await aria("02-revoked-section-open");
  await check("API: the revoked key no longer authenticates", async () => (await submit(kOld.key, [fixture("pool", "late")])).status === 401);

  await step("Enable a revoked key: it moves back to the active list and authenticates again");
  await revoked.getByRole("listitem").filter({ hasText: again }).getByRole("button", { name: "Enable" }).click();
  await check("Active again with Revoke and Delete", async () => {
    const row = active.getByRole("listitem").filter({ hasText: again });
    return (await row.getByRole("button", { name: "Revoke" }).isVisible()) && (await row.getByRole("button", { name: "Delete" }).isVisible());
  });
  await check("API: enabled and submitting", async () => (await listOf()).some((k) => k.id === kAgain.id && k.enabled) && (await submit(kAgain.key, [fixture("pool", "again")])).status === 202);
  await bottom();
  await shot("03-after-enable");

  await step("Delete asks for confirmation; Cancel keeps the key");
  await revoked.getByRole("listitem").filter({ hasText: old }).getByRole("button", { name: "Delete" }).click();
  await check("The confirmation names the key", () => confirm.getByText(`Delete “${old}”?`).isVisible());
  await bottom();
  await shot("04-delete-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await check("Nothing was deleted", async () => (await listOf()).some((k) => k.id === kOld.id));

  await step("Delete the revoked key, and an active key");
  await revoked.getByRole("listitem").filter({ hasText: old }).getByRole("button", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await check("API: the revoked key is gone", async () => !(await listOf()).some((k) => k.id === kOld.id));
  await check("The row is gone from the section, whose count dropped", async () => (await revoked.getByText(old).count()) === 0);
  await active.getByRole("listitem").filter({ hasText: keep }).getByRole("button", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await check("API: the active key is gone and its secret no longer works", async () =>
    !(await listOf()).some((k) => k.id === kKeep.id) && (await submit(kKeep.key, [fixture("pool", "keep")])).status === 401);
  await bottom();
  await shot("05-after-delete");

  await step("Usage keeps the deleted key's Links under its stored name, marked Deleted");
  const usage = await check("API: the deleted key is in the usage summary with status deleted", async () => {
    const u = await api.get("/usage/summary");
    const row = u.month.apiKeys.find((k: { id: string }) => k.id === kOld.id);
    return row?.status === "deleted" && row.name === old && row.links === 1 && u;
  });
  await page.reload();
  await check("Settings Usage shows 'API key: <name>' with a Deleted badge and its count", async () => {
    const row = page.getByRole("region", { name: "Usage" }).getByRole("listitem").filter({ hasText: old });
    return (await row.getByText("Deleted").isVisible()) && (await row.textContent())?.endsWith("1");
  });
  await bottom();
  await shot("06-usage-deleted");
  await note("usage", usage.month.apiKeys);

  await step("A body that is not valid JSON gets a clear 400 (what zsh's url-quote-magic produces)");
  const curl = Bun.spawn(
    ["curl", "-s", "-w", "\n%{http_code}", "-X", "POST", `${ui}/api/v1/links`, "-H", `Authorization: Bearer ${kAgain.key}`, "-H", "Content-Type: application/json", "-d", '{"urls":["https://example.com/a\\?b\\=c"]}'],
    { stdout: "pipe" },
  );
  const out = (await new Response(curl.stdout).text()).trim();
  await note("07-invalid-json-response", { output: out });
  await check("curl: 400 saying the body is not valid JSON", () => out.endsWith("400") && /"error":"Body is not valid JSON/.test(out));
}) satisfies Journey;
