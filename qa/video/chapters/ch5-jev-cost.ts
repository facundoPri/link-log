// Chapter 5 "Jev failures cost what they cost" (FAC-52 Jev preflight + FAC-54 retries by phase and batch stop):
// planning/qa/fac-48-test-plan.md §12 and §2 (JC-*), §4 (JP-*), §8 (X-03).
// No real Jev request: every scenario runs the real TypeSafe code path against the QA Worker's fake TypeSafe. The plan's
// profiles become per-scenario Worker configurations, restarted on the same D1/R2 (keepState), as the plan restarts dev:
//   CONFIGURED  JEV_PROVIDER=typesafe, key "qa-fake-key"      (stands in for FIX / "key fixed")
//   NOKEY       JEV_PROVIDER=typesafe, no key                  (NOKEY)
//   BADKEY      JEV_PROVIDER=typesafe, key "qa-fake-invalid"   (BADKEY: the fake answers 401, like the plan's real 401)
// Provider errors use the content marker `qa:jev-http=500` (402 for the balance case). Content is pasted (API setup).
import { resolve } from "node:path";
import type { Locator, Page } from "playwright-core";
import { chapter, scenario, type Api, type ScenarioContext } from "../recorder";
import { API, OUT, type EnvOptions } from "../env";

type Ctx = Pick<ScenarioContext, "page" | "click" | "paste" | "expect" | "api" | "step" | "hover">;

const CONFIGURED: EnvOptions = { jev: "fake-typesafe" };
const NOKEY: EnvOptions = { jev: "fake-typesafe", vars: { TYPESAFE_API_KEY: "" } };
const BADKEY: EnvOptions = { jev: "fake-typesafe", vars: { TYPESAFE_API_KEY: "qa-fake-invalid" } };

const attentionNav = (page: Page) => page.locator("aside").getByRole("button", { name: /Needs attention/ });
const activityNav = (page: Page) =>
  page.locator("aside").getByRole("button", { name: /^(Activity|Extracting|Fetching preview|Auto-tagging|Applying lens)/ });
const activity = (page: Page) => page.getByRole("dialog", { name: "Activity" });
const jobRows = (page: Page): Locator => activity(page).locator("div.rounded-md");
const batchCard = (page: Page, label: string) =>
  activity(page).locator("div.rounded-lg").filter({ has: page.getByText(label, { exact: true }) });
const row = (page: Page, text: string) => page.locator("main article").filter({ hasText: text });
const bar = (page: Page) => page.getByLabel("Selected link actions");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

const TAG = "qa tag"; // "QA tag", stored lowercase
const LENS = "QA lens";
const NOT_CONFIGURED = "Jev is not configured: API key missing.";
const REFUSED = "Jev refused the request: check the API key or the account balance. It may have been billed.";
const STOPPED = "Stopped before calling Jev (no cost): Jev refused an earlier request in this batch. Check the API key or the account balance.";
const PROVIDER = "Jev returned an error (may have been billed).";
const ALREADY = "These links were already retried.";
/** The three links of JC-* / JP-01 / JP-02, by the path in their title ("QA article jc-00/trio-1"). */
const TITLES = ["trio-1", "trio-2", "trio-3"];

/** Every job in the library (all batches), with its batch id and kind. */
async function allJobs(api: Api) {
  const lib = await api.library();
  const details = await Promise.all((lib.batches ?? []).map(async (b: any) => ({ b, jobs: ((await api.get(`/batches/${b.id}`)) as any).jobs ?? [] })));
  return details.flatMap(({ b, jobs }) => jobs.map((j: any) => ({ ...j, kind: b.kind as string, batch: b.id as string })));
}
const batchesOf = async (api: Api, kind: string) => ((await api.library()).batches ?? []).filter((b: any) => b.kind === kind);
const jobsIn = async (api: Api, batchId: string) => ((await api.get(`/batches/${batchId}`)) as any).jobs as any[];
/** Jev rows in Usage (fake Browser calls are metered as cloudflare/browser-markdown and are not Jev). */
const jevUsage = async (api: Api, linkIds?: string[]) =>
  ((await api.get<{ events: any[] }>("/usage")).events ?? []).filter((e) => !/browser/i.test(`${e.provider} ${e.service} ${e.operation}`) && (!linkIds || linkIds.includes(e.link_id)));
const content = async (api: Api, id: string) => (await api.get<{ markdown: string }>(`/links/${id}/content`)).markdown;
const byId = async (api: Api, id: string) => (await api.library()).links.find((l) => l.id === id)!;
const lensId = async (api: Api) => (await api.library()).lenses.find((l: any) => l.name === LENS)?.id as string;
const tagged = (l: any) => l.tags.some((t: any) => t.name === TAG);
/** X-03: no link carries attention. */
const noAttention = async (api: Api) => (await api.library()).links.every((l) => l.attention_kind === null);

/** JSON log lines of this run (the log restarts with the stack). */
async function logEvents(event: string): Promise<any[]> {
  const text = [await Bun.file(resolve(OUT, "logs/dev.log")).text(), await Bun.file(resolve(OUT, "logs/dev.err.log")).text().catch(() => "")].join("\n");
  // Wrangler colours console.error lines: strip the ANSI codes before parsing.
  return text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").flatMap((line) => {
    const at = line.indexOf(`{"event":"${event}"`);
    if (at < 0) return [];
    try {
      return [JSON.parse(line.slice(at))];
    } catch {
      return [];
    }
  });
}

/** Setup: the tag "QA tag" and the lens "QA lens"; both survive the runner's reset, so creating them is idempotent. */
async function ensureTagAndLens(api: Api) {
  await api.send("POST", "/tags", { name: "QA tag" }).catch(() => {});
  await api.send("POST", "/lenses", { name: LENS, type: "noul", question: "Is this a QA article?" }).catch(() => {}); // 409 when it exists
}

/** Setup: a link extracted by the fixture reader, then given pasted content (markers steer the fake Jev). */
async function readyLink({ expect, api }: Pick<Ctx, "expect" | "api">, url: string, markdown: string) {
  await api.send("POST", "/import", { urls: [url] });
  await expect(`Setup: ${new URL(url).pathname.slice(1)} is extracted`, async () => {
    const l = await api.link(url);
    return l && !l.processing && l.content_state === "ready";
  }, { timeout: 40_000 });
  const l = (await api.link(url))!;
  await api.send("PUT", `/links/${l.id}/content`, { markdown });
  await expect(`Setup: its content is “${markdown}”`, async () => (await content(api, l.id)).includes(markdown));
  return (await api.link(url))!;
}

async function pick({ click }: Pick<Ctx, "click">, rows: Locator[]) {
  for (const r of rows) await click(r.getByRole("checkbox"));
}
async function barButton({ page, click, expect }: Pick<Ctx, "page" | "click" | "expect">, name: string) {
  const b = bar(page).getByRole("button", { name, exact: true });
  await expect(`${name} is enabled`, () => b.isEnabled(), { timeout: 5_000 });
  await click(b);
}
async function openBatch({ page, click }: Pick<Ctx, "page" | "click">, label: string, nth = 0) {
  if (!(await activity(page).isVisible())) await click(activityNav(page));
  await click(batchCard(page, label).nth(nth).getByText(label, { exact: true }));
}
async function closeActivity({ page, expect }: Pick<Ctx, "page" | "expect">) {
  await page.keyboard.press("Escape");
  await expect.hidden(activity(page), "Activity closed");
}
const recoveryTick = () => fetch(`${API}/cdn-cgi/local/scheduled`).then((r) => r.ok);

/** Shows an API call and its answer in a terminal-like panel over the app (JC-04's "terminal overlay"). */
async function terminal(page: Page, lines: string[]) {
  await page.evaluate((text) => {
    let el = document.getElementById("qa-terminal");
    if (!el) {
      el = document.createElement("pre");
      el.id = "qa-terminal";
      el.setAttribute("style", "position:fixed;right:24px;top:24px;z-index:2147483000;width:640px;margin:0;padding:14px 16px;border-radius:10px;background:#0d1117;color:#c9d1d9;font:12px/1.55 ui-monospace,Menlo,monospace;white-space:pre-wrap;box-shadow:0 12px 32px rgba(0,0,0,.35)");
      document.body.appendChild(el);
    }
    el.textContent = text;
  }, lines.join("\n"));
}

/** Opens a link's Inspector on the Analysis tab. */
async function analysis({ page, click }: Pick<Ctx, "page" | "click">, r: Locator) {
  await click(r.locator("p").first());
  await click(page.getByRole("tab", { name: "Analysis" }));
}

/** Replaces a link's content in the Inspector (Content → Edit → Save). */
async function editContent({ page, click, paste, expect, api }: Pick<Ctx, "page" | "click" | "paste" | "expect" | "api">, r: Locator, id: string, text: string) {
  await click(r.locator("p").first());
  await click(page.getByRole("tab", { name: "Content" }));
  await click(page.getByRole("button", { name: "Edit content" }));
  await paste(page.locator("textarea"), text);
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect(`API: the content is now “${text}”`, async () => (await content(api, id)).trim() === text, { timeout: 8_000 });
  await page.keyboard.press("Escape");
}

/** The three links of JC-*, JP-01 and JP-02 (created in JC-00 and kept across the restarts). */
async function trio(api: Api) {
  const lib = await api.library();
  return TITLES.map((t) => lib.links.find((l) => l.title?.includes(t))!);
}

export default chapter({
  id: "ch5-jev-cost",
  title: "Jev failures cost what they cost",
  ticket: "FAC-52 · FAC-54",
  summary: [
    "No Jev key: Auto-tag, Lens, Re-evaluate and “run now” are off and say why; the API refuses and writes nothing",
    "A refused key stops the rest of the batch before calling Jev: one call, one Usage row, nothing in Needs attention",
    "After fixing the key, Retry failed runs the whole batch",
    "A provider error may have been billed, so it is never retried automatically; a manual Retry works, once",
    "No request leaves the machine: a local fake TypeSafe answers (401 for the bad key, 500/402 by content marker)",
  ],
  env: CONFIGURED,
  scenarios: [
    scenario("JC-00", "Setup: with Jev configured, three links with content and one lens result", {
      ticket: "FAC-52",
      covers: "Setup for JC-01..JC-04, JP-01 and JP-02 (the plan's step 1 under FIX): the tag, the lens, three links with pasted content, and a lens result on the first link.",
      expected: "Jev is configured (fake TypeSafe): the lens “QA lens” runs on the first link and its result shows in the Inspector.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: the tag “QA tag”, the lens “QA lens” and three links with pasted content (API)", "Three ready links");
      await ensureTagAndLens(api);
      const links: any[] = [];
      for (const [i, t] of TITLES.entries()) {
        links.push(await readyLink(ctx, fixture("article", t), `QA content ${i + 1}. jev:yes`));
      }
      await page.reload();
      await expect("API: the three links are ready and titled", async () => (await trio(api)).every((l) => l && l.content_state === "ready"), { timeout: 5_000 });
      await expect("Health: Jev is TypeSafe with a key (the local fake)", async () => (await api.library()).capabilities?.jev === true && (await api.library()).capabilities?.provider === "typesafe");

      await step("Select the first link and apply the lens “QA lens”", "Jev answers and the lens result is stored");
      const [one] = await trio(api);
      const r1 = row(page, TITLES[0]!);
      await expect.visible(r1, "Row: “QA article …/trio-1”");
      await pick(ctx, [r1]);
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(LENS) }));
      await expect("API: the first link has a “QA lens” result", async () => {
        const id = await lensId(api);
        return (await byId(api, one!.id)).lens_results.some((x: any) => x.lens_id === id);
      }, { timeout: 20_000 });
      await expect("Log: one call reached the fake TypeSafe (200)", async () => (await logEvents("qa_fake_typesafe")).filter((e) => e.status === 200).length === 1);
      await page.keyboard.press("Escape");
      await analysis(ctx, r1);
      await expect.visible(page.getByRole("tabpanel").getByRole("button", { name: LENS, exact: true }).first(), "Inspector → Analysis lists the lens “QA lens”");
      await page.keyboard.press("Escape");
    }),

    scenario("JC-01", "JC-01: without a Jev key, Auto-tag and Lens are off and say why", {
      ticket: "FAC-52 (52-AC1)",
      covers: "JC-01 (P0): profile NOKEY (TypeSafe without an API key), restarted on the same data.",
      expected: "With a ready link selected, Auto-tag and Lens are disabled and the tooltip reads “Jev is not configured: API key missing.”.",
      env: NOKEY,
      keepState: true,
    }, async (ctx) => {
      const { page, step, hover, expect, api } = ctx;
      await step("The server was restarted without the Jev API key, on the same data", "The library is unchanged; Jev is not configured");
      await page.reload();
      await expect("API: capabilities say Jev is TypeSafe and not configured", async () => {
        const c = (await api.library()).capabilities;
        return c?.provider === "typesafe" && c?.jev === false;
      });
      const r1 = row(page, TITLES[0]!);
      await expect.visible(r1, "The three links are still there");

      await step("Select a ready link and point at Auto-tag", `Disabled: “${NOT_CONFIGURED}”`);
      await pick(ctx, [r1]);
      const tag = bar(page).getByRole("button", { name: "Auto-tag", exact: true });
      const lens = bar(page).getByRole("button", { name: "Lens", exact: true });
      await expect("Auto-tag is disabled", async () => !(await tag.isEnabled()));
      await hover(tag);
      await expect.visible(page.getByRole("tooltip").getByText(NOT_CONFIGURED).first(), `Tooltip on Auto-tag: “${NOT_CONFIGURED}”`);

      await step("Point at Lens", `Disabled, same reason`);
      await expect("Lens is disabled", async () => !(await lens.isEnabled()));
      await hover(lens);
      await expect.visible(page.getByRole("tooltip").getByText(NOT_CONFIGURED).first(), `Tooltip on Lens: “${NOT_CONFIGURED}”`);
    }),

    scenario("JC-02", "JC-02: the Inspector's Re-evaluate and lens “Run again” are off; earlier results stay", {
      ticket: "FAC-52 (52-AC1)",
      covers: "JC-02: the first link has a lens result from before the restart (JC-00).",
      expected: "Inspector → Analysis: Re-evaluate disabled with “Jev is not configured: API key missing.”; the lens “QA lens” result is still listed and its “Run again” is disabled with the same reason.",
      env: NOKEY,
      keepState: true,
    }, async (ctx) => {
      const { page, step, hover, expect } = ctx;
      await step("Open the first link in the Inspector → Analysis", "The earlier lens result is still there");
      const r1 = row(page, TITLES[0]!);
      await analysis(ctx, r1);
      const panel = page.getByRole("tabpanel");
      await expect.visible(panel.getByRole("button", { name: LENS, exact: true }).first(), "Analysis still lists the lens “QA lens” (earlier result)");

      await step("Point at Re-evaluate", `Disabled: “${NOT_CONFIGURED}”`);
      const re = panel.getByRole("button", { name: "Re-evaluate" });
      await expect("Re-evaluate is disabled", async () => !(await re.isEnabled()));
      await hover(re);
      await expect.visible(page.getByRole("tooltip").getByText(NOT_CONFIGURED).first(), `Tooltip on Re-evaluate: “${NOT_CONFIGURED}”`);

      await step("Point at the lens result, then at its “Run again”", "Also disabled, same reason");
      await hover(panel.getByRole("button", { name: LENS, exact: true }).first());
      const again = panel.getByRole("button", { name: "Run again" });
      await expect("“Run again” is disabled", async () => !(await again.isEnabled()));
      await hover(again);
      // Radix opens a tooltip on pointer movement over its trigger: nudge the cursor over the icon.
      const box = (await again.boundingBox())!;
      for (const dx of [-3, 2, -1, 3, 0]) await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 3 });
      await expect.visible(page.getByRole("tooltip").getByText(NOT_CONFIGURED).first(), `Tooltip on Run again: “${NOT_CONFIGURED}”`);
      await page.keyboard.press("Escape");
    }),

    scenario("JC-03", "JC-03: a new lens can be saved, but “run now” is off", {
      ticket: "FAC-52 (52-AC1)",
      covers: "JC-03: with 2 links selected, Sidebar → New lens.",
      expected: "“Run on the 2 selected links now” is unchecked and disabled, with the reason below it. Save creates the lens; no batch appears.",
      env: NOKEY,
      keepState: true,
    }, async (ctx) => {
      const { page, step, click, paste, expect, api } = ctx;
      const before = ((await api.library()).batches ?? []).length;
      await step("Select two links, then Sidebar → New lens", "The dialog offers to run on the 2 selected links");
      await pick(ctx, [row(page, TITLES[0]!), row(page, TITLES[1]!)]);
      await expect.visible(bar(page).getByText("2 selected", { exact: true }), "2 selected");
      await click(page.locator("aside").getByRole("button", { name: "New lens" }));
      const dialog = page.getByRole("dialog");
      await expect.visible(dialog.getByText("Run on the 2 selected links now"), "“Run on the 2 selected links now”");
      const runNow = dialog.getByRole("checkbox").last();
      await expect("“Run now” is unchecked and disabled", async () => !(await runNow.isChecked()) && !(await runNow.isEnabled()));
      await expect.visible(dialog.getByText(NOT_CONFIGURED, { exact: true }), `The reason below it: “${NOT_CONFIGURED}”`);

      await step("Name it “QA lens no key”, ask a question, Save", "The lens is created; nothing runs");
      await paste(dialog.getByRole("textbox").first(), "QA lens no key");
      const textboxes = dialog.getByRole("textbox");
      if ((await textboxes.count()) > 1) await paste(textboxes.nth(1), "Is this a QA article?");
      await click(dialog.getByRole("button", { name: /^(Save|Create)/ }));
      await expect.visible(toast(page, "Lens created"), "Toast: “Lens created”");
      await expect("API: the lens “QA lens no key” exists", async () => (await api.library()).lenses.some((l: any) => l.name === "QA lens no key"));
      await expect.holds("No batch is created (3 s)", 3_000, async () => ((await api.library()).batches ?? []).length === before);
    }),

    scenario("JC-04", "JC-04: the API refuses Auto-tag and Lens, and writes nothing", {
      ticket: "FAC-52 (52-AC1, 52-AC2)",
      covers: "JC-04 (P0): POST /api/batches for autotag and lens without a key.",
      expected: "Both answer 400 {\"error\":\"Jev is not configured: API key missing.\"}; no new batch, no new Usage row; the log has jev_not_configured.",
      env: NOKEY,
      keepState: true,
    }, async (ctx) => {
      const { page, step, expect, api, hold } = ctx as Ctx & Pick<ScenarioContext, "hold">;
      const links = await trio(api);
      const ids = links.map((l) => l.id);
      const batches = ((await api.library()).batches ?? []).length;
      const usage = (await jevUsage(api)).length;
      const call = async (body: unknown) => {
        const r = await fetch(`${API}/api/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as any };
      };

      await step("POST /api/batches {kind: autotag} for the three links", "400: “Jev is not configured: API key missing.”");
      const a = await call({ kind: "autotag", ids });
      await terminal(page, [`$ curl -X POST /api/batches -d '{"kind":"autotag","ids":[3 links]}'`, `HTTP ${a.status}`, JSON.stringify(a.body), ""]);
      await expect("Autotag: HTTP 400 with the reason", () => a.status === 400 && a.body.error === NOT_CONFIGURED);

      await step("POST /api/batches {kind: lens} for the three links", "400, same reason");
      const lens = await lensId(api);
      const b = await call({ kind: "lens", lensId: lens, ids });
      await terminal(page, [
        `$ curl -X POST /api/batches -d '{"kind":"autotag","ids":[3 links]}'`, `HTTP ${a.status}`, JSON.stringify(a.body), "",
        `$ curl -X POST /api/batches -d '{"kind":"lens","lensId":"<QA lens>","ids":[3 links]}'`, `HTTP ${b.status}`, JSON.stringify(b.body),
      ]);
      await expect("Lens: HTTP 400 with the reason", () => b.status === 400 && b.body.error === NOT_CONFIGURED);
      await hold(2_000, "Reading the answers");

      await step("Check Activity, Usage and the log", "No new batch, no new Usage row; jev_not_configured logged");
      await expect("API: no new batch", async () => ((await api.library()).batches ?? []).length === batches);
      await expect("API: no new Jev Usage row", async () => (await jevUsage(api)).length === usage);
      await expect("Log: jev_not_configured for autotag and for lens", async () => {
        const e = await logEvents("jev_not_configured");
        return e.some((x) => x.kind === "autotag" && x.links === 3) && e.some((x) => x.kind === "lens" && x.links === 3);
      });
      await page.evaluate(() => document.getElementById("qa-terminal")?.remove());
      await ctx.click(activityNav(page));
      await expect.visible(activity(page), "Activity is open");
      await expect("Activity shows only the earlier lens batch (no Auto-tag card)", async () =>
        (await batchCard(page, "Auto-tag").count()) === 0 && (await batchCard(page, `Lens: ${LENS}`).count()) === 1);
      await closeActivity(ctx);
    }),

    scenario("JP-01", "JP-01: a refused key stops the rest of the batch before calling Jev", {
      ticket: "FAC-54 (54-AC3)",
      covers: "JP-01 (P0) + X-03: profile BADKEY (the fake TypeSafe answers 401 to the key), restarted on the same data; Auto-tag the three links.",
      expected: "One job “Jev refused the request…”, two “Stopped before calling Jev (no cost)…”. One call reached Jev and Usage has exactly one new Jev row. No link enters Needs attention.",
      env: BADKEY,
      keepState: true,
    }, async (ctx) => {
      const { page, step, expect, api, hold } = ctx as Ctx & Pick<ScenarioContext, "hold">;
      await step("The server was restarted with an invalid Jev key, on the same data", "Jev counts as configured");
      await page.reload();
      await expect("API: Jev is TypeSafe and configured (a key is set)", async () => {
        const c = (await api.library()).capabilities;
        return c?.provider === "typesafe" && c?.jev === true;
      });
      const links = await trio(api);
      const ids = links.map((l) => l.id);
      const usage = (await jevUsage(api, ids)).length;

      await step("Select the three links → Auto-tag", "The first call is refused; the batch stops");
      await pick(ctx, TITLES.map((t) => row(page, t)));
      await expect.visible(bar(page).getByText("3 selected", { exact: true }), "3 selected");
      await barButton(ctx, "Auto-tag");
      await expect("API: the Auto-tag batch settled: 1 account, 2 account_stopped", async () => {
        const [b] = await batchesOf(api, "autotag");
        if (!b) return false;
        const jobs = await jobsIn(api, b.id);
        return jobs.length === 3 && jobs.every((j) => j.status === "failed")
          && jobs.filter((j) => j.reason === "account").length === 1 && jobs.filter((j) => j.reason === "account_stopped").length === 2;
      }, { timeout: 20_000 });

      await step("Open Activity → Auto-tag", "One “Jev refused the request…”, two “Stopped before calling Jev (no cost)…”");
      await openBatch(ctx, "Auto-tag");
      await expect("Activity: one job reads “Jev refused the request…”", async () => (await activity(page).getByText(REFUSED, { exact: true }).count()) === 1, { timeout: 5_000 });
      await expect("Activity: two jobs read “Stopped before calling Jev (no cost)…”", async () => (await activity(page).getByText(STOPPED, { exact: true }).count()) === 2, { timeout: 5_000 });
      await hold(1_500, "Reading Activity");

      await step("Check Usage, the calls and Needs attention", "Exactly one Jev call and one Usage row; nothing in Needs attention");
      await expect("Fake TypeSafe: exactly one call, answered 401", async () => {
        const calls = await logEvents("qa_fake_typesafe"); // this run's log (it restarts with the stack)
        return calls.length === 1 && calls[0].status === 401;
      });
      await expect("Usage: exactly one new Jev row for the three links", async () => (await jevUsage(api, ids)).length === usage + 1);
      await expect("Log: jev_step_failed (sent, account, HTTP 401) and jev_batch_stopped (2 stopped)", async () => {
        const failed = await logEvents("jev_step_failed");
        const stopped = await logEvents("jev_batch_stopped");
        return failed.some((e) => e.phase === "sent" && e.reason === "account" && e.http_status === 401) && stopped.some((e) => e.stopped === 2);
      });
      await expect("X-03: API: no link has attention", () => noAttention(api));
      await closeActivity(ctx);
      await expect.hidden(attentionNav(page), "X-03: Sidebar: no Needs attention entry");
    }),

    scenario("JP-02", "JP-02: after fixing the key, Retry failed runs the whole batch", {
      ticket: "FAC-54 (54-AC3)",
      covers: "JP-02 (P0) + JP-08: restarted with a working key (the fake TypeSafe) on the same data; Activity → the failed Auto-tag → Retry failed.",
      expected: "Toast “Retrying”; a new Auto-tag batch runs all 3 to done; 3 new Jev Usage rows; all three links get “qa tag”.",
      env: CONFIGURED,
      keepState: true,
    }, async (ctx) => {
      const { page, step, click, expect, api } = ctx;
      await step("The server was restarted with a working key, on the same data", "The failed batch is still in Activity");
      await page.reload();
      const links = await trio(api);
      const ids = links.map((l) => l.id);
      const usage = (await jevUsage(api, ids)).length;
      const [failed] = await batchesOf(api, "autotag");
      await expect("API: one Auto-tag batch, 3 failed", async () => (await batchesOf(api, "autotag")).length === 1 && (await jobsIn(api, failed.id)).every((j) => j.status === "failed"));

      await step("Activity → Auto-tag → Retry failed", "“Retrying”; a new batch tags all three");
      await click(activityNav(page));
      await click(batchCard(page, "Auto-tag").first().getByRole("button", { name: "Retry failed", exact: true }));
      await expect.visible(toast(page, "Retrying"), "Toast: “Retrying”");
      await expect("API: a new Auto-tag batch with 3 jobs, all done", async () => {
        const b = (await batchesOf(api, "autotag")).find((x: any) => x.id !== failed.id);
        if (!b) return false;
        const jobs = await jobsIn(api, b.id);
        return jobs.length === 3 && jobs.every((j) => j.status === "done");
      }, { timeout: 30_000 });
      await expect("Usage: 3 new Jev rows", async () => (await jevUsage(api, ids)).length === usage + 3);
      await expect("API: all three links are tagged “qa tag”", async () => (await trio(api)).every(tagged));
      await expect("Activity: two Auto-tag cards", async () => (await batchCard(page, "Auto-tag").count()) === 2, { timeout: 5_000 });
      await closeActivity(ctx);
      for (const t of TITLES) await expect.visible(row(page, t).getByText(TAG, { exact: true }).first(), `Row “${t}” shows “qa tag”`);
      await expect.hidden(attentionNav(page), "No Needs attention entry");
    }),

    scenario("JP-03", "JP-03: a provider error may have been billed — never retried automatically; manual Retry works", {
      ticket: "FAC-54 (54-AC2)",
      covers: "JP-03 (P0) + X-03: a link whose Jev call answers HTTP 500 (marker qa:jev-http=500); apply the lens; fix the content; Retry the job.",
      expected: "“Jev returned an error (may have been billed).” after one attempt, one Jev call and one Usage row, nothing resent, not in Needs attention. After editing the content, the job's Retry creates a new batch that succeeds.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture, hold } = ctx as Ctx & Pick<ScenarioContext, "hold" | "fixture">;
      await step("Setup: the lens and a link whose content makes Jev answer HTTP 500", "A ready link");
      await ensureTagAndLens(api);
      const L = await readyLink(ctx, fixture("article", "five-hundred"), "QA provider error qa:jev-http=500");
      await page.reload();
      const r = row(page, L.title);

      await step("Select it → Lens → “QA lens”", "Jev answers 500: the job fails once");
      await pick(ctx, [r]);
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(`^${LENS}`) }).first());
      let first: any;
      await expect("API: the lens job failed, reason provider_error, attempt 1", async () => {
        const [b] = await batchesOf(api, "lens");
        if (!b) return false;
        [first] = await jobsIn(api, b.id);
        first = { ...first, batch: b.id };
        return first?.status === "failed" && first.reason === "provider_error" && first.attempt === 1;
      }, { timeout: 20_000 });

      await step("Open Activity → Lens: QA lens", `“${PROVIDER}”, no second attempt`);
      await openBatch(ctx, `Lens: ${LENS}`);
      await expect.visible(activity(page).getByText(PROVIDER, { exact: true }), `Activity: “${PROVIDER}”`);
      await expect.hidden(activity(page).getByText(/Attempt 2/), "Activity: no “Attempt 2”");

      await step("Wait, and run a recovery tick", "Nothing is resent: still one call and one Usage row");
      await recoveryTick();
      await expect.holds("For 8 s: one Jev call (500), one Usage row, one job, attempt 1", 8_000, async () => {
        const calls = (await logEvents("qa_fake_typesafe")).filter((e) => e.status === 500);
        const jobs = (await allJobs(api)).filter((j) => j.kind === "lens" && j.link_id === L.id);
        return calls.length === 1 && (await jevUsage(api, [L.id])).length === 1 && jobs.length === 1 && jobs[0].attempt === 1 && jobs[0].status === "failed";
      });
      await expect("Log: jev_step_failed (sent, provider_error, HTTP 500, final, not retryable)", async () =>
        (await logEvents("jev_step_failed")).some((e) => e.job_id === first.id && e.phase === "sent" && e.reason === "provider_error" && e.http_status === 500 && e.final === true && e.retryable === false));
      await expect("X-03: API: the link has no attention", async () => (await byId(api, L.id)).attention_kind === null);
      await closeActivity(ctx);
      await expect.hidden(attentionNav(page), "X-03: Sidebar: no Needs attention entry");

      await step("Fix the content in the Inspector (Edit → Save)", "The content no longer makes Jev fail");
      await editContent(ctx, r, L.id, "QA clean content jev:yes");

      await step("Activity → Lens: QA lens → the job's Retry", "A new lens batch runs and succeeds");
      await openBatch(ctx, `Lens: ${LENS}`);
      await click(jobRows(page).filter({ hasText: PROVIDER }).getByRole("button", { name: "Retry", exact: true }));
      await expect.visible(toast(page, "Retrying"), "Toast: “Retrying”");
      await expect("API: a new lens batch, its job done; the lens result is stored", async () => {
        const jobs = (await allJobs(api)).filter((j) => j.kind === "lens" && j.link_id === L.id && j.batch !== first.batch);
        const id = await lensId(api);
        return jobs.length === 1 && jobs[0].status === "done" && (await byId(api, L.id)).lens_results.some((x: any) => x.lens_id === id);
      }, { timeout: 20_000 });
      await expect("Usage: now two Jev rows for the link (the failed call and the retry)", async () => (await jevUsage(api, [L.id])).length === 2);
      await expect("Activity: two “Lens: QA lens” cards", async () => (await batchCard(page, `Lens: ${LENS}`).count()) === 2, { timeout: 5_000 });
      await hold(1_000, "Done");
      await closeActivity(ctx);
    }),

    scenario("JP-04", "JP-04: a double-clicked Retry failed enqueues once", {
      ticket: "FAC-54 (CR finding 2)",
      covers: "JP-04: a lens batch of 3 links whose Jev calls answered 500; the contents are fixed; Retry failed is double-clicked.",
      expected: "One new batch with 3 jobs, and the toast “These links were already retried.”. After it succeeds, Retry failed again gives the same toast and no new Usage rows.",
    }, async (ctx) => {
      const { page, step, click, hover, expect, api, fixture } = ctx as Ctx & Pick<ScenarioContext, "fixture">;
      await step("Setup: the lens and three links whose content makes Jev answer HTTP 500", "Three ready links");
      await ensureTagAndLens(api);
      const links: any[] = [];
      for (const n of ["a", "b", "c"]) links.push(await readyLink(ctx, fixture("article", `dbl-${n}`), `QA double ${n} qa:jev-http=500`));
      const ids = links.map((l) => l.id);
      await page.reload();

      await step("Select the three → Lens → “QA lens”", "All three fail with “may have been billed”");
      await pick(ctx, links.map((l) => row(page, l.title)));
      await expect.visible(bar(page).getByText("3 selected", { exact: true }), "3 selected");
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(`^${LENS}`) }).first());
      let failed: any;
      await expect("API: the lens batch has 3 failed jobs (provider_error)", async () => {
        [failed] = await batchesOf(api, "lens");
        if (!failed) return false;
        const jobs = await jobsIn(api, failed.id);
        return jobs.length === 3 && jobs.every((j) => j.status === "failed" && j.reason === "provider_error");
      }, { timeout: 20_000 });
      await expect("Usage: 3 Jev rows (each call may have been billed)", async () => (await jevUsage(api, ids)).length === 3);

      await step("Setup: replace the three contents with plain text (API)", "Jev will answer now");
      for (const l of links) await api.send("PUT", `/links/${l.id}/content`, { markdown: `QA fixed ${l.title} jev:yes` });
      await expect("API: the contents no longer carry the 500 marker", async () => (await Promise.all(ids.map((id) => content(api, id)))).every((c) => !c.includes("qa:jev-http")));

      await step("Activity → Lens: QA lens → double-click Retry failed", `One new batch; the second click says “${ALREADY}”`);
      await click(activityNav(page));
      const retry = batchCard(page, `Lens: ${LENS}`).first().getByRole("button", { name: "Retry failed", exact: true });
      await hover(retry);
      await retry.dblclick();
      await expect.visible(toast(page, ALREADY), `Toast: “${ALREADY}”`);
      await expect("API: exactly one new lens batch, with 3 jobs, all done", async () => {
        const all = await batchesOf(api, "lens");
        if (all.length !== 2) return false;
        const fresh = all.find((b: any) => b.id !== failed.id);
        const jobs = await jobsIn(api, fresh.id);
        return jobs.length === 3 && jobs.every((j) => j.status === "done");
      }, { timeout: 30_000 });
      await expect("Usage: 3 new Jev rows (6 in all)", async () => (await jevUsage(api, ids)).length === 6);

      await step("Click Retry failed on the original batch again", `“${ALREADY}”, nothing is sent`);
      await page.keyboard.press("Escape");
      await expect.hidden(activity(page), "Activity closed");
      await click(activityNav(page));
      const original = batchCard(page, `Lens: ${LENS}`).filter({ hasText: "3 failed" });
      await expect("Activity: the original batch still shows “3 failed”", async () => (await original.count()) === 1, { timeout: 5_000 });
      const toasts = await toast(page, ALREADY).count();
      await click(original.getByRole("button", { name: "Retry failed", exact: true }));
      await expect("A new toast: “These links were already retried.”", async () => (await toast(page, ALREADY).count()) > toasts || (await toast(page, ALREADY).count()) >= 1, { timeout: 5_000 });
      await expect.holds("For 3 s: still 2 lens batches and 6 Jev Usage rows", 3_000, async () =>
        (await batchesOf(api, "lens")).length === 2 && (await jevUsage(api, ids)).length === 6);
      await closeActivity(ctx);
    }),

    scenario("JP-01b", "JP-01b: an out-of-balance answer (402) stops the batch the same way", {
      ticket: "FAC-54 (54-AC3)",
      covers: "JP-01 with the balance variant (HTTP 402 “Insufficient balance”) under a working key; X-03.",
      expected: "One job “Jev refused the request…”, two “Stopped before calling Jev (no cost)…”; one Jev call and one Usage row; nothing in Needs attention.",
    }, async (ctx) => {
      const { page, step, expect, api, fixture } = ctx as Ctx & Pick<ScenarioContext, "fixture">;
      await step("Setup: the tag and three links whose content makes Jev answer 402 (out of credits)", "Three ready links");
      await ensureTagAndLens(api);
      const links: any[] = [];
      for (const n of ["a", "b", "c"]) links.push(await readyLink(ctx, fixture("article", `broke-${n}`), `QA balance ${n} qa:jev-http=402`));
      const ids = links.map((l) => l.id);
      const calls = (await logEvents("qa_fake_typesafe")).filter((e) => e.status === 402).length;
      await page.reload();

      await step("Select the three → Auto-tag", "The first call gets 402; the batch stops");
      await pick(ctx, links.map((l) => row(page, l.title)));
      await barButton(ctx, "Auto-tag");
      await expect("API: 1 account, 2 account_stopped", async () => {
        const [b] = await batchesOf(api, "autotag");
        if (!b) return false;
        const jobs = await jobsIn(api, b.id);
        return jobs.length === 3 && jobs.filter((j) => j.reason === "account").length === 1 && jobs.filter((j) => j.reason === "account_stopped").length === 2;
      }, { timeout: 20_000 });
      await openBatch(ctx, "Auto-tag");
      await expect("Activity: one “Jev refused the request…”", async () => (await activity(page).getByText(REFUSED, { exact: true }).count()) === 1, { timeout: 5_000 });
      await expect("Activity: two “Stopped before calling Jev (no cost)…”", async () => (await activity(page).getByText(STOPPED, { exact: true }).count()) === 2, { timeout: 5_000 });
      await expect("Fake TypeSafe: exactly one new call, answered 402", async () => (await logEvents("qa_fake_typesafe")).filter((e) => e.status === 402).length === calls + 1);
      await expect("Usage: exactly one Jev row for the three links", async () => (await jevUsage(api, ids)).length === 1);
      await expect("X-03: API: no link has attention", () => noAttention(api));
      await closeActivity(ctx);
      await expect.hidden(attentionNav(page), "X-03: Sidebar: no Needs attention entry");
    }),
  ],
});
