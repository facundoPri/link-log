// api-curl-example (FAC-159): a new or regenerated API key's one-time secret is shown with a copyable
// curl example for the app's own origin. The copied command really submits a URL, and the example is
// gone with the secret after Done or leaving Settings.
import type { Journey } from "../scripts/journey";

export default (async ({ page, ui, step, check, shot, note }) => {
  const name = `Curl ${Date.now() % 100000}`;
  const keys = page.getByRole("region", { name: "API keys" });
  const example = keys.getByLabel("curl example");
  const secretOf = async () => ((await keys.getByLabel("New API key").textContent()) ?? "").trim();

  await step("Create a key: the curl example appears with the secret");
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await keys.getByLabel("Name").fill(name);
  await keys.getByRole("button", { name: "Create key" }).click();
  const secret = await check("The secret is shown", async () => (await secretOf()).match(/^lk_[A-Za-z]{40,}$/)?.[0]);
  await check("The example targets the app's origin and carries the secret", async () => {
    const text = (await example.textContent()) ?? "";
    return text.includes(`curl -X POST ${ui}/api/v1/links`) && text.includes(`Authorization: Bearer ${secret}`);
  });
  await shot("01-after-create");

  await step("Copy curl puts the command on the clipboard, and it works");
  await keys.getByRole("button", { name: "Copy curl" }).click();
  const copied = await check("Clipboard holds the example", async () => {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    return text.includes(secret) && text;
  });
  const p = Bun.spawn(["sh", "-c", copied.replace("curl ", `curl -s -w '\\n%{http_code}' `).replace("https://example.com", `https://curl-${Date.now()}.example.com`)], { stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  await note("02-copied-command-response", { command: copied.replace(secret, "lk_…"), output: out });
  await check("Running the copied command answers 202 with a created result", () => out.trim().endsWith("202") && out.includes('"status":"created"'));

  await step("Done removes the secret and the example");
  await keys.getByRole("button", { name: "Done" }).click();
  await check("Both are gone", async () => (await example.count()) === 0 && (await keys.getByLabel("New API key").count()) === 0);
  await shot("03-after-done");

  await step("Regenerate: a new secret and example appear; leaving Settings removes them");
  await keys.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Regenerate" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Regenerate" }).click();
  const second = await check("A different secret is shown", async () => {
    const s = await secretOf();
    return /^lk_[A-Za-z]{40,}$/.test(s) && s !== secret && s;
  });
  await check("The example carries the new secret, not the old one", async () => {
    const text = (await example.textContent()) ?? "";
    return text.includes(second) && !text.includes(secret);
  });
  await shot("04-after-regenerate");
  await page.goBack();
  await page.getByRole("button", { name: "demo-a@linklog.test" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await check("After leaving and returning, neither secret nor example is in the page", async () =>
    (await example.count()) === 0 && !(await page.content()).includes(second) && !(await page.content()).includes("curl -X POST"));
  await shot("05-after-leaving");
}) satisfies Journey;
