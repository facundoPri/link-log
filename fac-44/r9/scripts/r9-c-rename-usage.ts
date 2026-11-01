// FAC-44 r8 item c: a key renamed through the plugin update route keeps submitting; Settings Usage
// shows the new name. Deleted from Settings, Usage still lists it under its last name, marked Deleted.
export default async ({ page, api, ui, fixture, step, check, shot, aria, note }: any) => {
  const stamp = Date.now() % 100000;
  const oldName = `R8 Original ${stamp}`, newName = `R8 Renamed ${stamp}`;
  const submit = (secret: string, urls: string[]) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
  const row = () => page.getByRole("region", { name: "Usage" }).getByRole("list", { name: "Links saved by source" }).getByRole("listitem").filter({ hasText: `API key: ${newName}` });

  await step("Create a key and submit with it under its original name");
  const key = await api.send("POST", "/auth/api-key/create", { name: oldName });
  await check("API: first submission creates a Link (202)", async () => (await submit(key.key, [fixture("article", "o1")])).status === 202);

  await step("Rename it through POST /api/auth/api-key/update and keep submitting");
  const renamed = await api.send("POST", "/auth/api-key/update", { keyId: key.id, name: newName });
  await check("API: the update returns the new name", () => renamed.name === newName);
  await check("API: the renamed key submits two more Links (202)", async () => (await submit(key.key, [fixture("article", "n1"), fixture("article", "n2")])).status === 202);
  await check("API: a Duplicate from it is accepted and not counted", async () => (await (await submit(key.key, [fixture("article", "o1")])).json()).results[0].status === "duplicate");
  const live = await check("API: Usage lists the key under the new name, active, 3 links", async () => {
    const r = (await api.get("/usage/summary")).month.apiKeys.find((k: any) => k.id === key.id);
    return r?.name === newName && r.status === "active" && r.links === 3 && r;
  });
  await note("01-usage-live", live);

  await step("Settings Usage shows the new name");
  await page.goto(`${ui}/settings`);
  await check("UI: 'API key: <new name>' with 3 and no badge", async () => (await row().isVisible()) && (await row().textContent())?.endsWith("3") && (await row().getByText("Deleted").count()) === 0);
  await check("UI: the old name is nowhere on the page", async () => (await page.getByText(oldName).count()) === 0);
  const keys = page.getByRole("region", { name: "API keys" });
  await check("UI: the API keys list shows the new name", () => keys.getByRole("listitem").filter({ hasText: newName }).isVisible());
  await page.getByRole("region", { name: "Usage" }).scrollIntoViewIfNeeded();
  await shot("01-usage-renamed");

  await step("Delete the key from Settings");
  await keys.getByRole("listitem").filter({ hasText: newName }).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await check("The confirmation names the key by its new name", () => confirm.getByText(`Delete “${newName}”?`).isVisible());
  await confirm.getByRole("button", { name: "Delete" }).click();
  await check("API: the key is gone and its secret answers 401", async () =>
    !(await api.get("/auth/api-key/list")).apiKeys.some((k: any) => k.id === key.id) && (await submit(key.key, [fixture("article", "late")])).status === 401);
  const gone = await check("API: Usage keeps it under the last name, status deleted, 3 links", async () => {
    const r = (await api.get("/usage/summary")).month.apiKeys.find((k: any) => k.id === key.id);
    return r?.name === newName && r.status === "deleted" && r.links === 3 && r;
  });
  await note("02-usage-deleted", gone);
  await page.reload();
  await check("UI after reload: 'API key: <new name>' with a Deleted badge and 3", async () => (await row().getByText("Deleted").isVisible()) && (await row().textContent())?.endsWith("3"));
  await page.getByRole("region", { name: "Usage" }).scrollIntoViewIfNeeded();
  await shot("02-usage-deleted");
  await aria("02-usage-deleted");
};
