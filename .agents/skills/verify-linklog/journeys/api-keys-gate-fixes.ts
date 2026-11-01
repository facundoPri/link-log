// api-keys-gate-fixes (FAC-44): proves three behaviors of the key routes and Usage through the running
// app. Keys always start with lk_ (a client-chosen prefix or configId is refused), Usage shows a renamed
// key under its current name, and creating, renaming and deleting a key draw on the same
// 120-per-minute writes budget as the rest of the app (429 with Retry-After once it is spent, and the
// Settings page says so). The last step spends Demo A's writes budget for up to a minute.
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

  await step("Key writes draw on the shared writes budget: once it is spent, a create is refused with a 429");
  // Better Auth's own limit is 100 a minute per IP and path, so alternate two paths to reach the 120.
  let refused;
  for (let i = 0; i < 130 && !refused; i++) {
    const res = i % 2 ? await post("/auth/api-key/delete", { keyId: "does-not-exist" }) : await post("/auth/api-key/update", { keyId: key.id, name: renamed });
    if (res.status() === 429) refused = res;
  }
  await check("API: a key write is refused with 429 after at most 120 writes in the minute", () => !!refused);
  const retryAfter = Number(refused!.headers()["retry-after"]);
  const refusedBody = await refused!.json();
  await note("04-refused-raw", { headers: refused!.headers(), body: refusedBody });
  await check("The 429 has Retry-After (1 to 60 seconds) and Better Auth's error shape with code writes", () => retryAfter >= 1 && retryAfter <= 60 && refusedBody.code === "writes" && typeof refusedBody.message === "string");
  await note("04-refused", { status: 429, retryAfter, body: refusedBody });
  const create = await post("/auth/api-key/create", { name: `Refused ${stamp}` });
  await check("API: a create is refused too", async () => create.status() === 429 && (await create.json()).code === "writes");
  await check("API: a delete is refused too", async () => (await post("/auth/api-key/delete", { keyId: key.id })).status() === 429);
  await check("API: the key is still there and nothing was created", async () => {
    const keys = (await api.get("/auth/api-key/list")).apiKeys as { id: string; name: string }[];
    return keys.some((k) => k.id === key.id) && !keys.some((k) => k.name === `Refused ${stamp}`);
  });
  await check("API: the API key's own submissions share the spent budget (429 writes)", async () => (await submit([fixture("article", "r3")])).status === 429);

  await step("Settings tells the user");
  const keys = page.getByRole("region", { name: "API keys" });
  await keys.getByLabel("Name").fill(`Refused ${stamp}`);
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("Settings shows the limit message and creates nothing", () => keys.getByText("Too many requests. Try again later.").isVisible());
  await shot("04-settings-refused");
}) satisfies Journey;
