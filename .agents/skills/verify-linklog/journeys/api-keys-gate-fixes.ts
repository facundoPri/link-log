// api-keys-gate-fixes (FAC-44): proves three behaviors of the key routes and Usage through the running
// app. Keys always start with lk_ (a client-chosen prefix or configId is refused), Usage shows a renamed
// key under its current name, and creating, renaming and enabling a key draw on the same
// 120-per-minute writes budget as the rest of the app (429 with Retry-After once it is spent, and the
// Settings page says so). Revoking and deleting a key never do: with the budget spent by the key's own
// submissions, Settings still revokes and deletes it, and it then answers 401. The last steps spend
// Demo A's writes budget for up to a minute.
import type { Journey } from "../scripts/journey";

type Usage = { month: { apiKeys: { id: string; name: string; links: number; status: string }[] } };

export default (async ({ page, api, ui, fixture, step, check, shot, note }) => {
  const stamp = Date.now() % 100000;
  const post = (path: string, data: unknown) => page.request.post(`${ui}/api${path}`, { headers: { Origin: ui }, data });

  await step("A key always starts with lk_: a client-chosen prefix or configuration is refused");
  for (const extra of [{ prefix: "abc" }, { configId: "default" }]) {
    const res = await post("/auth/api-key/create", { name: `Prefixed ${stamp}`, ...extra });
    const body = await res.json();
    await check(`API: create with ${JSON.stringify(extra)} is 400 SERVER_ONLY_PROPERTY`, () => res.status() === 400 && body.code === "SERVER_ONLY_PROPERTY");
    await note(`01-refused-${Object.keys(extra)[0]}`, { status: res.status(), body });
  }
  await check("API: nothing was created by the refused requests", async () => !(await api.get("/auth/api-key/list")).apiKeys.some((k: { name: string }) => k.name === `Prefixed ${stamp}`));
  const key = await (await post("/auth/api-key/create", { name: `Shortcuts ${stamp}` })).json();
  await check("API: a plain create returns an lk_ secret and an lk_ visible start", () => key.key.startsWith("lk_") && key.start.startsWith("lk_"));
  await note("02-created", { start: key.start, name: key.name });
  const other = await (await post("/auth/api-key/create", { name: `Spare ${stamp}` })).json();

  await step("Usage shows the key under its current name after a rename");
  const submit = (urls: string[]) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify({ urls }) });
  await check("API: the key submits a Link", async () => (await submit([fixture("article", "r1")])).status === 202);
  const renamed = `Alpha ${stamp}`;
  await check("API: the key is renamed", async () => (await post("/auth/api-key/update", { keyId: key.id, name: renamed })).status() === 200);
  await check("API: the key submits another Link", async () => (await submit([fixture("article", "r2")])).status === 202);
  const usage = await check("API: Usage lists the key as the new name with both Links", async () => {
    const u = (await api.get("/usage/summary")) as Usage;
    const row = u.month.apiKeys.find((k) => k.id === key.id);
    return row?.name === renamed && row.links === 2 && u;
  });
  await note("03-usage-summary", usage.month.apiKeys.find((k) => k.id === key.id));
  await page.goto(`${ui}/settings`);
  const usageRegion = page.getByRole("region", { name: "Usage" });
  await check("Settings > Usage shows the row under the new name", () => usageRegion.getByText(`API key: ${renamed}`).isVisible());
  await shot("03-usage-renamed");

  await step("Key writes draw on the shared writes budget: the key's own submissions spend it, and a create is then refused");
  // A request with a valid key spends the owner's budget even when it ends in 400.
  let spent;
  for (let i = 0; i < 130 && !spent; i++) {
    const res = await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify({ urls: ["not a url"] }) });
    if (res.status === 429) spent = res;
  }
  await check("API: the key's own submissions run the writes budget out within 120 in the minute", () => !!spent);
  const retryAfter = Number(spent!.headers.get("retry-after"));
  const spentBody = await spent!.json();
  await note("04-spent-raw", { body: spentBody, retryAfter });
  await check("The 429 has Retry-After (1 to 60 seconds) and code writes", () => retryAfter >= 1 && retryAfter <= 60 && spentBody.code === "writes");
  const create = await post("/auth/api-key/create", { name: `Refused ${stamp}` });
  const refusedBody = await create.json();
  await note("04-refused", { status: create.status(), retryAfter: create.headers()["retry-after"], body: refusedBody });
  await check("API: a create is refused in Better Auth's error shape", () => create.status() === 429 && refusedBody.code === "writes" && typeof refusedBody.message === "string" && Number(create.headers()["retry-after"]) >= 1);
  await check("API: a rename is refused too", async () => (await post("/auth/api-key/update", { keyId: key.id, name: `Renamed ${stamp}` })).status() === 429);
  await check("API: nothing was created", async () => !((await api.get("/auth/api-key/list")).apiKeys as { name: string }[]).some((k) => k.name === `Refused ${stamp}`));

  await step("Settings tells the user a create is refused");
  await page.goto(`${ui}/settings`);
  const keys = page.getByRole("region", { name: "API keys" });
  await keys.getByLabel("Name").fill(`Refused ${stamp}`);
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("Settings shows the limit message and creates nothing", () => keys.getByText("Too many requests. Try again later.").isVisible());
  await shot("05-settings-refused");

  await step("With the budget still spent, the owner revokes and deletes the leaked key from Settings");
  const confirm = page.getByRole("alertdialog");
  const answered = (route: "update" | "delete") => page.waitForResponse((r) => r.url().includes(`/api/auth/api-key/${route}`) && r.request().method() === "POST");
  const row = (list: ReturnType<typeof keys.locator>) => list.getByRole("listitem").filter({ hasText: renamed });
  const revoking = answered("update");
  await row(keys).getByRole("button", { name: "Revoke" }).click();
  await confirm.getByRole("button", { name: "Revoke" }).click();
  const revokeStatus = (await revoking).status();
  await note("06-revoke-status", { status: revokeStatus });
  await check("Revoke answers 200 with the budget spent", () => revokeStatus === 200);
  await check("API: the key is disabled", async () => ((await api.get("/auth/api-key/list")).apiKeys as { id: string; enabled: boolean }[]).some((k) => k.id === key.id && !k.enabled));
  const afterRevoke = await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify({ urls: ["not a url"] }) });
  await note("06-key-after-revoke", { status: afterRevoke.status });
  await check("The revoked key answers 401 on /api/v1/links", () => afterRevoke.status === 401);
  await shot("06-revoked-with-spent-budget");

  const spareDeleting = answered("delete");
  await keys.getByRole("listitem").filter({ hasText: `Spare ${stamp}` }).getByRole("button", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  const spareStatus = (await spareDeleting).status();
  await check("Delete of an active key answers 200 with the budget spent", () => spareStatus === 200);
  const revokedSection = keys.locator("details");
  await revokedSection.getByText(/^Revoked keys \(\d+\)$/).click();
  const deleting = answered("delete");
  await row(revokedSection).getByRole("button", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  const deleteStatus = (await deleting).status();
  await note("07-delete-status", { leaked: deleteStatus, spare: spareStatus });
  await check("Delete of the revoked key answers 200 with the budget spent", () => deleteStatus === 200);
  await check("API: both keys are gone", async () => {
    const list = (await api.get("/auth/api-key/list")).apiKeys as { id: string }[];
    return !list.some((k) => k.id === key.id || k.id === other.id);
  });
  await check("The deleted key still answers 401", async () => (await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify({ urls: ["not a url"] }) })).status === 401);
  await shot("07-deleted-with-spent-budget");
}) satisfies Journey;
