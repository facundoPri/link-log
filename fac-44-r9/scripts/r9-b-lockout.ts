// FAC-44 r9 items 2 and 3: a leaked key spends the owner's writes budget with 120+ Bearer
// submissions; in the same minute the owner still revokes it (200, then 401) and deletes another key
// from Settings (200), while Create key, Enable, rename and disable-plus-rename are refused 429 writes.
export default async ({ page, api, ui, fixture, step, check, shot, aria, note }: any) => {
  const stamp = Date.now() % 100000;
  const submit = (secret: string, urls: string[]) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
  const post = (path: string, data: unknown) => page.request.post(`${ui}/api${path}`, { headers: { Origin: ui }, data });
  const minute = () => Math.floor(Date.now() / 60000);
  const statuses: Record<string, unknown> = {};

  const leaked = await api.send("POST", "/auth/api-key/create", { name: `R9 Leaked ${stamp}` });
  const spare = await api.send("POST", "/auth/api-key/create", { name: `R9 Spare ${stamp}` });
  const parked = await api.send("POST", "/auth/api-key/create", { name: `R9 Parked ${stamp}` });
  const combo = await api.send("POST", "/auth/api-key/create", { name: `R9 Combo ${stamp}` });
  await api.send("POST", "/auth/api-key/update", { keyId: parked.id, enabled: false });
  const dup = fixture("article", "seed");
  await check("API: the leaked key saves the seed Link", async () => (await submit(leaked.key, [dup])).status === 202);

  await step("Wait for a fresh minute, then the leaked key spends the writes budget with Bearer submissions");
  await page.waitForTimeout((60 - ((Date.now() / 1000) % 60)) * 1000 + 300);
  const window = minute();
  let accepted = 0;
  let last: Response | undefined;
  for (; accepted < 200; accepted++) {
    last = await submit(leaked.key, [dup]);
    if (last.status !== 202) break;
  }
  const lastBody = await last!.json();
  const extra: number[] = [];
  for (let i = 0; i < 5; i++) extra.push((await submit(leaked.key, [dup])).status);
  statuses.spend = { accepted, firstRefused: { status: last!.status, retryAfter: last!.headers.get("retry-after"), body: lastBody }, nextFive: extra, totalBearerSubmissions: accepted + 1 + extra.length };
  await note("01-spent", statuses.spend);
  await check("API: 120 Bearer submissions accepted, then 429 writes; the next five are 429 too", () => accepted === 120 && last!.status === 429 && lastBody.code === "writes" && extra.every((s) => s === 429));

  await step("Settings with the budget spent");
  await page.goto(`${ui}/settings`);
  const keys = page.getByRole("region", { name: "API keys" });
  const row = (name: string) => keys.getByRole("listitem").filter({ hasText: name });
  await check("UI: the leaked key is listed as active", () => row(leaked.name).getByRole("button", { name: "Revoke" }).isVisible());
  await shot("01-settings-budget-spent");
  const answered = (route: "update" | "delete" | "create") => page.waitForResponse((r: any) => r.url().endsWith(`/api/auth/api-key/${route}`) && r.request().method() === "POST");
  const confirm = page.getByRole("alertdialog");

  await step("Revoke the leaked key from Settings");
  await row(leaked.name).getByRole("button", { name: "Revoke" }).click();
  await shot("02a-revoke-confirm");
  const revoking = answered("update");
  await confirm.getByRole("button", { name: "Revoke" }).click();
  const revokeRes = await revoking;
  const revokeSent = revokeRes.request().postDataJSON();
  statuses.revoke = { status: revokeRes.status(), sent: revokeSent, body: await revokeRes.json() };
  await check("HTTP: Revoke sent only keyId and enabled:false and got 200", () => revokeRes.status() === 200 && JSON.stringify(Object.keys(revokeSent).sort()) === JSON.stringify(["enabled", "keyId"]) && revokeSent.enabled === false);
  await check("UI: the leaked key left the active list (no Revoke button for it anywhere)", async () => (await row(leaked.name).getByRole("button", { name: "Revoke" }).count()) === 0);
  await check("UI: a Revoked keys section is present", () => keys.getByText(/^Revoked keys \(\d+\)$/).isVisible());
  await check("API: the key is disabled", async () => (await api.get("/auth/api-key/list")).apiKeys.some((k: any) => k.id === leaked.id && !k.enabled));
  const afterRevoke = await submit(leaked.key, [fixture("article", "after-revoke")]);
  statuses.leakedAfterRevoke = { status: afterRevoke.status, body: await afterRevoke.json() };
  await check("HTTP: the revoked key answers 401 on /api/v1/links", () => afterRevoke.status === 401);
  await shot("02b-revoked");

  await step("Delete the spare key from Settings");
  await row(spare.name).getByRole("button", { name: "Delete" }).click();
  await shot("03a-delete-confirm");
  const deleting = answered("delete");
  await confirm.getByRole("button", { name: "Delete" }).click();
  const deleteRes = await deleting;
  statuses.delete = { status: deleteRes.status(), body: await deleteRes.json() };
  await check("HTTP: Delete got 200", () => deleteRes.status() === 200);
  await check("UI: the spare key is gone from Settings", async () => (await row(spare.name).count()) === 0);
  await check("API: the spare key is gone from the list", async () => !(await api.get("/auth/api-key/list")).apiKeys.some((k: any) => k.id === spare.id));
  const spareAfter = await submit(spare.key, [fixture("article", "after-delete")]);
  statuses.spareAfterDelete = spareAfter.status;
  await check("HTTP: the deleted key answers 401", () => spareAfter.status === 401);
  await shot("03b-deleted");

  await step("Create key is still refused");
  await keys.getByLabel("Name").fill(`R9 Refused ${stamp}`);
  const creating = answered("create");
  await keys.getByRole("button", { name: "Create key" }).click();
  const createRes = await creating;
  const createBody = await createRes.json();
  statuses.create = { status: createRes.status(), retryAfter: createRes.headers()["retry-after"], body: createBody };
  await check("HTTP: Create key got 429 writes with Retry-After", () => createRes.status() === 429 && createBody.code === "writes" && Number(createRes.headers()["retry-after"]) >= 1);
  await check("UI: Settings shows Too many requests. Try again later.", () => keys.getByText("Too many requests. Try again later.").isVisible());
  await check("UI: no secret was shown", async () => (await keys.getByLabel("New API key").count()) === 0);
  await shot("04-create-refused");
  await aria("04-create-refused");

  await step("Enable a revoked key from Settings is refused");
  const revokedSection = keys.locator("details");
  await revokedSection.getByText(/^Revoked keys \(\d+\)$/).click();
  const enabling = answered("update");
  await revokedSection.getByRole("listitem").filter({ hasText: parked.name }).getByRole("button", { name: "Enable" }).click();
  const enableRes = await enabling;
  const enableBody = await enableRes.json();
  statuses.enable = { status: enableRes.status(), sent: enableRes.request().postDataJSON(), retryAfter: enableRes.headers()["retry-after"], body: enableBody };
  await check("HTTP: Enable got 429 writes", () => enableRes.status() === 429 && enableBody.code === "writes");
  await check("UI: a toast says Too many requests. Try again later.", () => page.getByText("Too many requests. Try again later.").last().isVisible());
  await shot("05-enable-refused");
  await check("API: the parked key is still disabled", async () => (await api.get("/auth/api-key/list")).apiKeys.some((k: any) => k.id === parked.id && !k.enabled));

  await step("Rename and disable-plus-rename are refused (the plugin update route, as Settings calls it)");
  const rename = await post("/auth/api-key/update", { keyId: combo.id, name: `R9 Renamed ${stamp}` });
  const both = await post("/auth/api-key/update", { keyId: combo.id, enabled: false, name: `R9 Renamed ${stamp}` });
  statuses.rename = { status: rename.status(), body: await rename.json() };
  statuses.disablePlusRename = { status: both.status(), body: await both.json() };
  await check("HTTP: rename 429 writes", () => rename.status() === 429 && (statuses.rename as any).body.code === "writes");
  await check("HTTP: disable-plus-rename 429 writes", () => both.status() === 429 && (statuses.disablePlusRename as any).body.code === "writes");
  await check("API: the combo key is still enabled under its old name", async () => (await api.get("/auth/api-key/list")).apiKeys.some((k: any) => k.id === combo.id && k.enabled && k.name === combo.name));

  statuses.sameMinute = { spentIn: window, endedIn: minute() };
  await note("06-statuses", statuses);
  await check("Every step ran in the minute the budget was spent", () => minute() === window);

  await step("Clean up: delete the leaked, parked and combo keys (free)");
  for (const k of [leaked, parked, combo]) await check(`API: delete ${k.name} -> 200`, async () => (await post("/auth/api-key/delete", { keyId: k.id })).status() === 200);
};
