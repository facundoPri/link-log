// FAC-44 r8 item a: key writes and API submissions share one writes budget per user (120/min).
// API submissions spend it, then a key create from Settings is refused (UI message + HTTP 429
// Retry-After code writes). Then the reverse: key writes spend it, then an API submission is 429
// writes. Demo B is unaffected both times. Spends Demo A's writes budget for two minutes.
export default async ({ page, pageAs, api, apiAs, ui, fixture, step, check, shot, note }: any) => {
  const stamp = Date.now() % 100000;
  const submit = (secret: string, urls: string[]) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
  const post = (path: string, data: unknown) => page.request.post(`${ui}/api${path}`, { headers: { Origin: ui }, data });
  const freshMinute = async () => {
    const s = (Date.now() / 1000) % 60;
    await page.waitForTimeout((60 - s) * 1000 + 300);
  };
  const key = await api.send("POST", "/auth/api-key/create", { name: `R9 Budget ${stamp}` });
  const keyB = await apiAs(1).send("POST", "/auth/api-key/create", { name: `R9 Budget B ${stamp}` });
  const dup = fixture("article", "seed");
  await check("API: the key saves the seed Link", async () => (await submit(key.key, [dup])).status === 202);

  await step("Wait for a fresh minute, then spend the writes budget with API submissions");
  await freshMinute();
  let accepted = 0;
  let last: Response | undefined;
  for (; accepted < 200; accepted++) {
    last = await submit(key.key, [dup]);
    if (last.status !== 202) break;
  }
  const lastBody = await last!.json();
  await check("API: 120 submissions accepted, then 429 writes", () => accepted === 120 && last!.status === 429 && lastBody.code === "writes");
  await note("01-api-spent", { accepted, status: last!.status, body: lastBody });

  await step("Create a key from Settings: refused with the limit message");
  await page.goto(`${ui}/settings`);
  const keys = page.getByRole("region", { name: "API keys" });
  await keys.getByLabel("Name").fill(`R9 Refused ${stamp}`);
  const [res] = await Promise.all([
    page.waitForResponse((r: any) => r.url().endsWith("/api/auth/api-key/create") && r.request().method() === "POST"),
    keys.getByRole("button", { name: "Create key" }).click(),
  ]);
  const body = await res.json();
  const retryAfter = Number(res.headers()["retry-after"]);
  await note("02-settings-create-response", { status: res.status(), retryAfter, headers: res.headers(), body });
  await check("HTTP: the Settings create got 429 with Retry-After (1-60 s) and code writes", () => res.status() === 429 && retryAfter >= 1 && retryAfter <= 60 && body.code === "writes");
  await check("UI: Settings shows Too many requests. Try again later.", () => keys.getByText("Too many requests. Try again later.").isVisible());
  await check("UI: no secret was shown", async () => (await keys.getByLabel("New API key").count()) === 0);
  await shot("02-settings-create-refused");
  await check("API: no key named R9 Refused exists", async () => !(await api.get("/auth/api-key/list")).apiKeys.some((k: any) => k.name === `R9 Refused ${stamp}`));

  await step("Demo B in the same minute: their Settings create works and their key submits");
  const pageB = await pageAs(1);
  await pageB.goto(`${ui}/settings`);
  const keysB = pageB.getByRole("region", { name: "API keys" });
  await keysB.getByLabel("Name").fill(`R8 B ok ${stamp}`);
  await keysB.getByRole("button", { name: "Create key" }).click();
  await check("UI (Demo B): the new lk_ secret is shown", async () => /^lk_/.test((await keysB.getByLabel("New API key").textContent()) ?? ""));
  await shot("03-demo-b-create-ok", pageB);
  await check("API (Demo B): their key submits (202)", async () => (await submit(keyB.key, [fixture("article", "b-1")])).status === 202);

  await step("Next minute: spend the budget with key writes, then an API submission is refused");
  await freshMinute();
  let writes = 0;
  let refused: any;
  const made: string[] = [];
  // r9: delete is free now, so create (charged) alternates with rename to stay under Better Auth's 100/min per path.
  for (; writes < 200 && !refused; writes++) {
    const r = writes % 2 ? await post("/auth/api-key/create", { name: `R9 Spend ${stamp} ${writes}` }) : await post("/auth/api-key/update", { keyId: key.id, name: key.name });
    if (writes % 2 && r.status() === 200) made.push((await r.json()).id);
    if (r.status() === 429) refused = r;
  }
  const cleanup: number[] = [];
  for (const id of made) cleanup.push((await post("/auth/api-key/delete", { keyId: id })).status());
  await note("04-spend-keys-deleted", { count: made.length, statuses: [...new Set(cleanup)] });
  await check("API: the spend keys are deleted with the budget spent (all 200)", () => cleanup.length > 0 && cleanup.every((s) => s === 200));
  const refusedBody = await refused?.json();
  await note("04-key-writes-spent", { attempts: writes, accepted: writes - 1, status: refused?.status(), retryAfter: refused?.headers()["retry-after"], body: refusedBody });
  await check("API: 120 key writes accepted, then 429 writes", () => writes - 1 === 120 && refusedBody?.code === "writes");
  const url = fixture("article", "after-key-writes");
  const api429 = await submit(key.key, [url]);
  const api429Body = await api429.json();
  await note("04-api-after-key-writes", { status: api429.status, retryAfter: api429.headers.get("retry-after"), body: api429Body });
  await check("API: the submission is 429 writes with Retry-After", () => api429.status === 429 && api429Body.code === "writes" && Number(api429.headers.get("retry-after")) >= 1);
  await check("API: and nothing was saved", async () => !(await api.link(url)));
  await page.reload();
  await keys.getByLabel("Name").fill(`R9 Refused2 ${stamp}`);
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("UI: Settings refuses a create again with the message", () => keys.getByText("Too many requests. Try again later.").isVisible());
  await shot("04-settings-refused-after-key-writes");
  await check("API (Demo B): unaffected, submission 202", async () => (await submit(keyB.key, [fixture("article", "b-2")])).status === 202);
};
