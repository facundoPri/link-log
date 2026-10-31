// FAC-44 final verification (round 6: round-5 journey plus the regenerate response's oldKey.status and no Revoke pending badge after a normal regenerate), UI half: Settings key lifecycle (one-time secret, copied curl, revoke,
// regenerate), the API batch in Activity and its cancel, Settings Usage against a ledger of this
// journey's own submissions, Demo B's library, and the 10-active-key cap. Run with
// `bun .agents/skills/verify-linklog/scripts/verify.ts run <this file>`.
export default async ({ page, api, apiAs, pageAs, ui, fixture, step, check, shot, aria, note }: any) => {
  const stamp = Date.now() % 100000;
  const name = `Shortcuts F${stamp}`;
  const other = `Revoke F${stamp}`;
  const keys = page.getByRole("region", { name: "API keys" });
  const row = (n: string) => keys.getByRole("listitem").filter({ hasText: n });
  const secretText = async () => ((await keys.getByLabel("New API key").textContent()) ?? "").trim();
  const submit = async (secret: string, urls: string[]) => {
    const r = await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const before = await api.get("/usage/summary");
  await note("00-usage-before", before);

  await step("Open Settings from the user menu");
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await check("User menu offers Settings", () => page.getByRole("menuitem", { name: "Settings" }).isVisible());
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await check("URL is /settings with the Settings heading", async () => page.url().endsWith("/settings") && (await page.getByRole("heading", { name: "Settings" }).isVisible()));
  await check("Account section shows the email and Sign out", async () => {
    const acct = page.getByRole("region", { name: "Account" });
    return (await acct.getByText("demo-a@linklog.test").isVisible()) && (await acct.getByRole("button", { name: "Sign out" }).isVisible());
  });

  await step("Create a named key: the full lk_ secret and the curl example are shown once");
  await keys.getByLabel("Name").fill(name);
  await keys.getByRole("button", { name: "Create key" }).click();
  const secret = await check("Full lk_ secret shown", async () => (await secretText()).match(/^lk_[A-Za-z0-9]{40,}$/)?.[0]);
  const example = keys.getByLabel("curl example");
  await check("curl example targets this origin and carries the secret", async () => {
    const t = (await example.textContent()) ?? "";
    return t.includes(`${ui}/api/v1/links`) && t.includes(`Bearer ${secret}`);
  });
  await example.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot("01-settings-one-time-secret-and-curl");
  await aria("01-settings-one-time-secret-and-curl");
  const listed = await check("API: key listed with prefix only, never the secret", async () => {
    const r = await api.get("/api-keys");
    const k = r.apiKeys.find((x: any) => x.name === name);
    return k && secret.startsWith(k.prefix) && k.prefix.length < 15 && !JSON.stringify(r).includes(secret) && k;
  });

  await step("Copy curl and run the copied command unchanged");
  await keys.getByRole("button", { name: "Copy curl" }).click();
  const copied = await check("Clipboard holds the curl command with the secret", async () => {
    const t = await page.evaluate(() => navigator.clipboard.readText());
    return t.includes(secret) && t.startsWith("curl") && t;
  });
  const proc = Bun.spawn(["sh", "-c", `${copied} -s -o /dev/stderr -w '%{http_code}'`], { stdout: "pipe", stderr: "pipe" });
  const [code, body] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await note("02-copied-curl-run", { command: copied.replace(secret, "lk_<secret>"), httpCode: code, body: JSON.parse(body) });
  const curlBody = JSON.parse(body);
  // The example URL is fixed, so on a rerun against the same instance it is a Duplicate.
  await check("Copied curl answers 202 (created, or duplicate on a rerun)", () => code.trim() === "202" && ["created", "duplicate"].includes(curlBody.results?.[0]?.status));
  const curlCreated = curlBody.results[0].status === "created" ? 1 : 0;

  await step("Done hides the secret; reload and leaving Settings never bring it back");
  await keys.getByRole("button", { name: "Done" }).click();
  await check("Secret and curl gone after Done", async () => (await keys.getByLabel("New API key").count()) === 0 && (await example.count()) === 0 && !(await page.content()).includes(secret));
  await page.reload();
  await check("Secret absent after reload", async () => (await row(name).count()) === 1 && !(await page.content()).includes(secret));
  await page.goBack();
  await page.goForward();
  await check("Secret absent after leaving and returning", async () => (await row(name).isVisible()) && !(await page.content()).includes(secret));
  await check("Row shows name, prefix, created date, status and this month's count", async () => {
    const t = (await row(name).textContent()) ?? "";
    return t.includes(listed.prefix) && t.includes("Active") && /Created/.test(t) && /Last used/.test(t) && new RegExp(`${curlCreated} links? this month`).test(t);
  });

  await step("Create and revoke a second key in the UI: it stops authenticating");
  await keys.getByLabel("Name").fill(other);
  await keys.getByRole("button", { name: "Create key" }).click();
  const otherSecret = await check("Second secret shown", async () => (await secretText()).match(/^lk_[A-Za-z0-9]{40,}$/)?.[0]);
  await keys.getByRole("button", { name: "Done" }).click();
  const otherOk = await submit(otherSecret, [fixture("article", "revoke-before")]);
  await check("Second key works before revoke (202)", () => otherOk.status === 202);
  await row(other).getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await check("Row shows Revoked without Revoke/Regenerate", async () =>
    (await row(other).getByText("Revoked").isVisible()) && (await row(other).getByRole("button", { name: "Revoke" }).count()) === 0 && (await row(other).getByRole("button", { name: "Regenerate" }).count()) === 0);
  const otherAfter = await submit(otherSecret, [fixture("article", "revoke-after")]);
  await check("Revoked key answers 401", () => otherAfter.status === 401);

  await step("Regenerate the first key in the UI: old secret 401, new secret 202");
  await row(name).getByRole("button", { name: "Regenerate" }).click();
  await check("Round 5 confirm wording: creates the new key, then revokes the current one; told if that fails", async () => {
    const t = (await page.getByRole("alertdialog").textContent()) ?? "";
    return t.includes("then revokes the current key") && t.includes("If that fails, you are told to revoke it yourself.");
  });
  const regenResponse = page.waitForResponse((r: any) => r.url().endsWith("/regenerate") && r.request().method() === "POST");
  await page.getByRole("alertdialog").getByRole("button", { name: "Regenerate" }).click();
  const regenBody = await (await regenResponse).json();
  await note("normal-regenerate-response", { oldKey: regenBody.oldKey, apiKey: regenBody.apiKey });
  await check("Round 6: normal regenerate response says oldKey.status revoked", () => regenBody.oldKey?.status === "revoked" && typeof regenBody.oldKey?.id === "string");
  const fresh = await check("New secret shown, different from the old", async () => {
    const s = await secretText();
    return /^lk_[A-Za-z0-9]{40,}$/.test(s) && s !== secret && s;
  });
  await check("Normal regenerate: notice says the old key no longer works, and there is no revoke-it-now warning and no Revoke pending badge", async () =>
    (await keys.getByRole("status").getByText(/The old key no longer works\./).isVisible()) && (await keys.getByText(/may still work|could not be revoked/).count()) === 0 && (await keys.getByRole("alert").count()) === 0 && (await keys.getByText("Revoke pending").count()) === 0);
  await check("Without a reload the old row already shows Revoked and the new one Active", async () =>
    (await row(name).filter({ hasText: "Active" }).count()) === 1 && (await row(name).filter({ hasText: "Revoked" }).count()) === 1);
  await page.waitForTimeout(300);
  await shot("03a-settings-after-normal-regenerate-no-warning");
  await aria("03a-settings-after-normal-regenerate-no-warning");
  const oldTry = await submit(secret, [fixture("article", "regen-old")]);
  await check("Old secret answers 401", () => oldTry.status === 401);
  await keys.getByRole("button", { name: "Done" }).click();
  await check("Key list: same name Active once and Revoked once", async () =>
    (await row(name).filter({ hasText: "Active" }).count()) === 1 && (await row(name).filter({ hasText: "Revoked" }).count()) === 1);
  await page.waitForTimeout(300);
  await shot("03-key-list-revoked-and-regenerated");
  await aria("03-key-list-revoked-and-regenerated");

  await step("The regenerated key submits 6 slow pool URLs; Activity labels the batch with the key name");
  const pool = Array.from({ length: 6 }, (_, i) => fixture("pool", `p${i}`));
  const sent = await submit(fresh, pool);
  await note("04-api-submit", sent);
  await check("New secret answers 202 with 6 created and a batchId", () => sent.status === 202 && sent.body.results.filter((r: any) => r.status === "created").length === 6 && sent.body.batchId);
  const dup = await submit(fresh, [pool[0]!]);
  await check("Resubmitting one is a Duplicate with no batch", () => dup.status === 202 && dup.body.results[0].status === "duplicate" && !("batchId" in dup.body));
  await page.goto(ui);
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const label = `Extract context · API · ${name}`;
  const trigger = sheet.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await check(`Activity shows "${label}"`, () => sheet.getByText(label, { exact: true }).first().isVisible());
  // Regenerate keeps the name, so the copied-curl batch of the old key carries the same label; the newest (first) is the pool batch.
  await check("Batches with the label: the new key's pool batch, plus the old key's curl batch when it created one", async () => (await trigger.count()) === 1 + curlCreated);
  const rowEl = trigger.first().locator("xpath=..");
  const cancel = rowEl.getByRole("button", { name: "Cancel batch" });
  await check("The API batch is active and offers Cancel batch", () => cancel.isVisible());
  await page.waitForTimeout(600);
  await shot("04-activity-api-batch-before-cancel");
  await aria("04-activity-api-batch-before-cancel");

  await step("Cancel the API batch from Activity");
  await cancel.click();
  const after = await check("API: batch has no active jobs and some were cancelled", async () => {
    const b = (await api.library()).batches.find((x: any) => x.id === sent.body.batchId);
    return b && b.active === 0 && b.cancelled > 0 && b;
  }, { timeout: 30_000 });
  await check("Activity no longer offers Cancel batch on that row", async () => (await cancel.count()) === 0, { timeout: 30_000 });
  await check("Label survives the cancel", () => sheet.getByText(label, { exact: true }).first().isVisible());
  await page.waitForTimeout(400);
  await shot("05-activity-api-batch-after-cancel");
  await note("05-batch-after-cancel", { batch: after, config: JSON.parse(after.config) });
  await page.keyboard.press("Escape");

  await step("Add one Web link through the Add link dialog");
  const webUrl = fixture("article", "web-dialog");
  await page.getByRole("button", { name: "Add link" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await dialog.getByRole("textbox").fill(webUrl);
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await check("API: the web link is saved", async () => !!(await api.link(webUrl)));
  await api.send("POST", "/import", { urls: [webUrl, pool[1]!] });

  await step("Settings Usage matches what this journey submitted");
  const oldKeyId = listed.id;
  const newKeyId = (await api.get("/api-keys")).apiKeys.find((k: any) => k.name === name && k.status === "active").id;
  const otherId = (await api.get("/api-keys")).apiKeys.find((k: any) => k.name === other).id;
  const expected = { links: before.month.links + 8 + curlCreated, web: before.month.web + 1, [oldKeyId]: curlCreated, [newKeyId]: 6, [otherId]: 1 };
  const usage = await check(`API summary: +${8 + curlCreated} links (${curlCreated} curl, 1 revoked key, 6 pool, 1 web), Web +1, old ${curlCreated}, new 6, revoked 1`, async () => {
    const u = await api.get("/usage/summary");
    const n = (id: string) => u.month.apiKeys.find((k: any) => k.id === id)?.links;
    return u.month.links === expected.links && u.month.web === expected.web && (n(oldKeyId) ?? 0) === curlCreated && n(newKeyId) === 6 && n(otherId) === 1 && u;
  });
  await note("06-usage-after", { expected, usage });
  await page.goto(`${ui}/settings`);
  const section = page.getByRole("region", { name: "Usage" });
  await check("Usage shows Links and Jobs windows with used / max and reset", async () => {
    const t = (await section.getByRole("list", { name: "Limits" }).textContent()) ?? "";
    return new RegExp(`Links\\s*${usage.quotas.links.used} / 500 this hour\\s*resets in`).test(t) && new RegExp(`Jobs\\s*${usage.quotas.jobs.used} / 300 this hour\\s*resets in`).test(t);
  });
  const by = section.getByRole("list", { name: "New Links by source" });
  await check(`Usage month: Web ${expected.web}, and per-key rows match`, async () => {
    const items = await by.getByRole("listitem").allTextContents();
    const web = items.find((t: string) => /^Web/.test(t.trim()));
    const count = (t: string, _n: string) => t.match(/(\d+)\s*$/)?.[1] ?? "";
    const named = items.filter((t: string) => t.includes(`API key: ${name}`)).map((t: string) => count(t, name)).sort();
    const rev = items.find((t: string) => t.includes(`API key: ${other}`));
    return web?.trim() === `Web${expected.web}` && named.join(",") === (curlCreated ? "1,6" : "6") && rev && count(rev, other) === "1";
  });
  await check(`Usage month total reads ${expected.links}`, async () => ((await section.textContent()) ?? "").includes(String(expected.links)));
  await page.waitForTimeout(400);
  await section.scrollIntoViewIfNeeded();
  await shot("06-settings-usage");
  await aria("06-settings-usage");

  await step("Demo B's library holds none of Demo A's links");
  const aLib = await api.library();
  const bLib = await apiAs(1).library();
  const aIds = new Set(aLib.links.map((l: any) => l.id));
  await check("API: no link id shared between the libraries; A's pool and curl links absent from B", () =>
    !bLib.links.some((l: any) => aIds.has(l.id)) && !bLib.links.some((l: any) => pool.includes(l.url) || l.url === webUrl || l.url === curlBody.results[0].url));
  const pageB = await pageAs(1);
  await check("Demo B's page loads its library", () => pageB.getByRole("button", { name: "demo-b@linklog.test" }).isVisible());
  await check("Demo B's page shows none of Demo A's links", async () => {
    const html = await pageB.content();
    return !html.includes(webUrl) && !pool.some((u) => html.includes(new URL(u).pathname)) && !html.includes("example.com/");
  });
  await pageB.waitForTimeout(600);
  await shot("07-demo-b-library", pageB);
  await aria("07-demo-b-library", pageB);
  await note("07-demo-b-library", { count: bLib.links.length, urls: bLib.links.map((l: any) => l.url) });

  await step("Fill to 10 active keys, then the 11th from the UI is refused with a clear message");
  const active = (await api.get("/api-keys")).apiKeys.filter((k: any) => k.status === "active").length;
  for (let i = active; i < 10; i++) await api.send("POST", "/api-keys", { name: `Fill ${i} F${stamp}` });
  await page.reload();
  await keys.getByLabel("Name").fill("Eleventh");
  await keys.getByRole("button", { name: "Create key" }).click();
  await check("Alert: You have 10 active API keys. Revoke one to create another.", () =>
    keys.getByRole("alert").getByText("You have 10 active API keys. Revoke one to create another.").isVisible());
  await check("API: still 10 active, no Eleventh", async () => {
    const list = (await api.get("/api-keys")).apiKeys;
    return list.filter((k: any) => k.status === "active").length === 10 && !list.some((k: any) => k.name === "Eleventh");
  });
  await keys.getByRole("alert").scrollIntoViewIfNeeded();
  await shot("08-cap-error");
};
