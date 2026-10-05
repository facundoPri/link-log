// Chapter 6 "Cancel means nothing happened" (FAC-55 + the cancel paths of FAC-48): planning/qa/fac-48-test-plan.md §12
// and §9 (CJ-*), with NA-26 / NA-29 from §1.
// Profile FIX-SLOT1: fixture Jev and one browser slot. An extraction reserves the slot before it fetches the preview, so a
// link added behind a slow page waits as "running · Preparing content" with no preview yet; that is the running
// extraction CJ-01 cancels. Setup that is not the point of a scenario (the tag, the lens, links with pasted content,
// neutral links from a cancelled import, a content-failed link) goes through the API; what the captions talk about happens
// in the UI. Batch cancel of an extraction waiting for the slot is not filmed again: chapter 4 (PQ-07) recorded that it
// answers "Nothing left to cancel" (those jobs are already "running"), so every cancel here uses the per-job ✕.
import { resolve } from "node:path";
import type { Locator, Page } from "playwright-core";
import { chapter, scenario, type Api, type Expect, type ScenarioContext } from "../recorder";
import { API, OUT } from "../env";

type Ctx = Pick<ScenarioContext, "page" | "click" | "paste" | "expect" | "api" | "step" | "hover">;

const attentionNav = (page: Page) => page.locator("aside").getByRole("button", { name: /Needs attention/ });
const activityNav = (page: Page) =>
  page.locator("aside").getByRole("button", { name: /^(Activity|Extracting|Fetching preview|Auto-tagging|Applying lens)/ });
const activity = (page: Page) => page.getByRole("dialog", { name: "Activity" });
const jobRows = (page: Page): Locator => activity(page).locator("div.rounded-md");
/** A batch card in Activity, by its label ("Auto-tag", "Extract context", "Lens: QA lens"). */
const batchCard = (page: Page, label: string) =>
  activity(page).locator("div.rounded-lg").filter({ has: page.getByText(label, { exact: true }) });
/** A library row, by text only it shows (its title, or its host while it has no preview yet). */
const row = (page: Page, text: string) => page.locator("main article").filter({ hasText: text });
const bar = (page: Page) => page.getByLabel("Selected link actions");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });
const badge = (r: Locator, text: string) => r.getByText(text, { exact: true });

const TAG = "qa tag";
const LENS = "QA lens";
const ACTIVE = ["queued", "running", "waiting"];
const BILLED = "Cancelled after calling Jev (may have been billed).";
const FINISHED = "This job already finished.";
const BUSY = "Wait for the running job to finish.";
const EMPTY = "Couldn't get the content: The page returned no content. You can paste it manually.";
const CASCADE2 = "Cancelled, and 2 waiting for that extraction";

/** Every job in the library (all batches), with its batch kind. */
async function allJobs(api: Api) {
  const lib = await api.library();
  const details = await Promise.all((lib.batches ?? []).map(async (b: any) => ({ b, jobs: ((await api.get(`/batches/${b.id}`)) as any).jobs ?? [] })));
  return details.flatMap(({ b, jobs }) => jobs.map((j: any) => ({ ...j, kind: b.kind as string })));
}
/** The jobs of one kind on one link, oldest first. */
const jobsOf = async (api: Api, linkId: string, kind: string) =>
  (await allJobs(api)).filter((j) => j.link_id === linkId && j.kind === kind).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const activeExtract = async (api: Api, linkId: string) => (await jobsOf(api, linkId, "extract")).find((j) => ACTIVE.includes(j.status));
const byId = async (api: Api, id: string) => (await api.library()).links.find((l) => l.id === id)!;
const content = async (api: Api, id: string) => (await api.get<{ markdown: string }>(`/links/${id}/content`)).markdown;
/** Jev rows in Usage for a link (fake Browser calls are metered as cloudflare/browser-markdown and are not Jev). */
const jevUsage = async (api: Api, linkId: string) =>
  ((await api.get<{ events: any[] }>("/usage")).events ?? []).filter((e) => e.link_id === linkId && !/browser/i.test(`${e.provider} ${e.service} ${e.operation}`));
const lensId = async (api: Api) => (await api.library()).lenses.find((x: any) => x.name === LENS)?.id as string;
const cancelled = (j: any) => j?.status === "failed" && j.step === "Cancelled";

/** `job_cancelled` lines the Worker logged for this job (wrangler colours some lines, so search for the JSON). */
async function cancelLog(jobId: string): Promise<any[]> {
  const text = await Bun.file(resolve(OUT, "logs/dev.log")).text();
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf('{"event":"job_cancelled"');
    if (at < 0) return [];
    try {
      const e = JSON.parse(line.slice(at));
      return e.job_id === jobId ? [e] : [];
    } catch {
      return [];
    }
  });
}

/** Polls until `done()` while requiring `invariant()` on every poll; a violation fails the check, naming what was seen. */
async function whileRunning(expect: Expect, name: string, done: () => Promise<boolean>, invariant: () => Promise<string | null>, timeout: number) {
  let broken: string | null = null;
  await expect(name, async () => {
    if (!broken) broken = await invariant();
    if (broken) throw new Error(broken);
    return done();
  }, { timeout });
}

/** Setup: the tag "QA tag" and the lens "QA lens"; both survive the runner's reset, so creating them is idempotent. */
async function ensureTagAndLens(api: Api) {
  await api.send("POST", "/tags", { name: "QA tag" }).catch(() => {});
  await api.send("POST", "/lenses", { name: LENS, type: "noul", question: "Is this a QA article?" }).catch(() => {}); // 409 when it exists
}

/** Setup: a link extracted by the fixture reader, then given pasted content (the Jev markers steer the fixture Jev). */
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

/** Setup: a link imported and cancelled at once, so it is neutral (no preview, no content, not processing, no attention). */
async function neutralLink({ expect, api }: Pick<Ctx, "expect" | "api">, url: string) {
  await api.send("POST", "/import", { urls: [url] });
  await expect(`Setup: ${new URL(url).host.split(".")[0]} import cancelled, the link is neutral`, async () => {
    const l = await api.link(url);
    if (!l) return false;
    for (const j of (await jobsOf(api, l.id, "extract")).filter((j) => ACTIVE.includes(j.status)))
      await api.send("DELETE", `/jobs/${j.id}`).catch(() => {});
    const now = await api.link(url);
    return now && !now.processing && now.content_state === "missing" && !now.content_key && !now.attention_kind;
  }, { timeout: 20_000 });
  return (await api.link(url))!;
}

/** Opens Add link, pastes `text` and saves. */
async function addLinks({ page, click, paste }: Pick<Ctx, "page" | "click" | "paste">, text: string) {
  await click(page.getByRole("button", { name: "Add link" }));
  await paste(page.getByRole("textbox"), text);
  await click(page.getByRole("button", { name: /^Save/ }));
}

/** Clicks a selection-bar button once it is enabled (it is disabled for a moment while a batch is submitted). */
async function barButton({ page, click, expect }: Pick<Ctx, "page" | "click" | "expect">, name: string) {
  const b = bar(page).getByRole("button", { name, exact: true });
  await expect(`${name} is enabled`, () => b.isEnabled(), { timeout: 5_000 });
  await click(b);
}

/** Opens Activity and expands the newest batch with this label. */
async function openBatch({ page, click }: Pick<Ctx, "page" | "click">, label: string) {
  if (!(await activity(page).isVisible())) await click(activityNav(page));
  await click(batchCard(page, label).first().getByText(label, { exact: true }));
}

async function closeActivity({ page, expect }: Pick<Ctx, "page" | "expect">) {
  await page.keyboard.press("Escape");
  await expect.hidden(activity(page), "Activity closed");
}

/** A toast reply, looked for in the DOM (Sonner can stack it behind a session progress toast). */
async function toastSeen(expect: Expect, page: Page, text: string) {
  await expect(`Toast: “${text}”`, async () => (await toast(page, text).count()) > 0, { timeout: 6_000 });
}

/** Shows an API call and its answer in a terminal-like panel over the app. */
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

/** A raw API call, keeping its status and body (api.send throws on non-2xx). */
async function raw(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data: any = await r.json().catch(() => ({}));
  return { status: r.status, error: data.error as string | undefined };
}

/** Runs the scheduled recovery (what cron does every 30 s): promotes orphaned waiting jobs and resends queued ones. */
const recoveryTick = () => fetch(`${API}/cdn-cgi/local/scheduled`).then((r) => r.ok);

export default chapter({
  id: "ch6-cancel",
  title: "Cancel means nothing happened",
  ticket: "FAC-55 · FAC-48",
  summary: [
    "Cancelling an extraction also cancels the Jev work waiting for it, and the link is left exactly as it was",
    "Cancel, then extract again: the link keeps processing until the new job ends",
    "A cancelled re-extract keeps the previous content and its version",
    "Cancelling a waiting Jev job takes only that job; a Lens cancelled mid-call says it may have been billed",
    "A finished job can't be cancelled; a cancelled retry leaves a Needs attention link as it was",
  ],
  env: { vars: { BROWSER_CONCURRENCY: "1" } },
  scenarios: [
    scenario("CJ-01", "CJ-01 + CJ-10: ✕ on a running extraction cancels it and the 2 Jev jobs waiting for it", {
      ticket: "FAC-55 (AC1, AC2, AC3)",
      covers: "CJ-01: cancel a running extraction with an auto-tag and a lens waiting on it. CJ-10: a batch made only of cancelled jobs reads “Cancelled”, never “failed”.",
      expected: "Tooltip “Cancel (also cancels what waits for it)”; toast “Cancelled, and 2 waiting for that extraction”; Extract, Auto-tag and Lens read “Cancelled”. The link reads “No preview yet”, is not processing and never enters Needs attention; the log has job_cancelled with dependents 2; a recovery tick resurrects nothing.",
    }, async (ctx) => {
      const { page, step, click, hover, expect, api, fixture } = ctx;
      await step("Setup: the tag “QA tag” and the lens “QA lens”", "Both exist");
      await ensureTagAndLens(api);
      await page.reload();

      await step("Add a slow page, then the link we will cancel (only one page is read at a time)", "The second link's extraction runs but waits for the browser, with no preview yet");
      const holder = fixture("slow-ok", "holder"), url = fixture("held-yes", "target");
      await addLinks(ctx, `${holder}\n${url}`);
      await expect.visible(toast(page, "2 links saved"), "Toast: 2 links saved");
      await expect("API: its extraction is running (waiting for the browser slot), no preview yet", async () => {
        const l = await api.link(url);
        const e = l && (await activeExtract(api, l.id));
        return e?.status === "running" && l!.status !== "ready";
      }, { timeout: 8_000 });
      const L = (await api.link(url))!;
      const r = row(page, "held-yes.qa.example");

      await step("Select it: Auto-tag, then select it again: Lens → “QA lens”", "Both wait for the extraction");
      await click(r.getByRole("checkbox"));
      await barButton(ctx, "Auto-tag");
      await click(r.getByRole("checkbox"));
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(LENS) }));
      await expect("API: the auto-tag and the lens are waiting", async () => {
        const [t] = await jobsOf(api, L.id, "autotag"), [l] = await jobsOf(api, L.id, "lens");
        return t?.status === "waiting" && l?.status === "waiting";
      }, { timeout: 8_000 });
      const extract = (await activeExtract(api, L.id))!;

      await step("Activity → Extract context → point at the link's ✕, then click it", "“Cancelled, and 2 waiting for that extraction”");
      await openBatch(ctx, "Extract context");
      const job = jobRows(page).filter({ hasText: "held-yes.qa.example" });
      const x = job.getByRole("button", { name: "Cancel", exact: true });
      await hover(x);
      await expect.visible(page.getByText("Cancel (also cancels what waits for it)").first(), "Tooltip: “Cancel (also cancels what waits for it)”");
      await click(x);
      await toastSeen(expect, page, CASCADE2);
      await expect.visible(job.getByText("Cancelled", { exact: true }).first(), "Activity: the extraction reads “Cancelled”");
      await expect("API: extraction, auto-tag and lens are all Cancelled (“Cancelled”; the two dependents “Cancelled: its extraction was cancelled”)", async () => {
        const e = (await jobsOf(api, L.id, "extract")).find((j) => j.id === extract.id);
        const [t] = await jobsOf(api, L.id, "autotag"), [l] = await jobsOf(api, L.id, "lens");
        return cancelled(e) && e.error === "Cancelled" && [t, l].every((j) => cancelled(j) && j.error === "Cancelled: its extraction was cancelled");
      });
      await expect("Log: job_cancelled for the extraction with dependents 2", async () => {
        const lines = await cancelLog(extract.id);
        if (lines.length !== 1 || lines[0].dependents !== 2 || lines[0].kind !== "extract") throw new Error(`log has ${JSON.stringify(lines)}`);
        return true;
      }, { timeout: 5_000 });

      await step("CJ-10: open the Auto-tag and Lens batches", "Each reads “Cancelled”: no “failed” count, no Retry");
      for (const label of ["Auto-tag", `Lens: ${LENS}`]) {
        await openBatch(ctx, label);
        const card = batchCard(page, label).first();
        await expect.visible(card.getByText("Cancelled", { exact: true }).first(), `${label}: the job and the batch read “Cancelled”`);
        await expect(`${label}: no “failed” badge, no Retry`, async () =>
          !(await card.getByText(/failed/).count()) && !(await card.getByRole("button", { name: /^Retry/ }).count()));
      }
      await expect("API: both batches count 1 cancelled, 0 failed", async () => {
        const bs = (await api.library()).batches.filter((b: any) => b.kind === "autotag" || b.kind === "lens");
        return bs.length === 2 && bs.every((b: any) => b.cancelled === 1 && b.failed === 0 && !b.active);
      });
      await closeActivity(ctx);

      await step("Run a recovery tick and wait", "Nothing comes back; the link is as before: no preview, not processing, not in Needs attention");
      await expect("Recovery tick ran", recoveryTick);
      await expect.holds("The link stays neutral: no preview, no content, not processing, no attention, no Jev usage; no job revived", 6_000, async () => {
        const l = await byId(api, L.id);
        const jobs = (await allJobs(api)).filter((j) => j.link_id === L.id);
        return !l.processing && l.status !== "ready" && l.content_state === "missing" && !l.attention_kind
          && !(await jevUsage(api, L.id)).length && jobs.every(cancelled);
      });
      await expect.visible(r.getByText("No preview yet"), "Its row reads “No preview yet”");
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),

    scenario("CJ-07", "CJ-07: cancel, then extract again at once — the link keeps processing until the new job ends", {
      ticket: "FAC-55 · FAC-48 (S10 fix)",
      covers: "CJ-07 (FAC-48 QA 24, S10): the cancelled job must not reset the state the new extraction set.",
      expected: "Right after the ✕, row menu → Extract context. The row reads “Extracting…” and the API keeps content_state “queued” until the new job ends; Auto-tag and Lens stay enabled. It ends ready; the old job stays “Cancelled”.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await ensureTagAndLens(api);
      await page.reload();
      const url = fixture("slow-preview", "page");
      await step("Add a page whose preview takes 8 s", "Activity reads “Fetching preview”");
      await addLinks(ctx, url);
      await expect.visible(toast(page, "Link saved"), "Toast: Link saved");
      await expect("API: its extraction is fetching the preview", async () => {
        const l = await api.link(url);
        return l && (await activeExtract(api, l.id))?.step === "Fetching preview";
      }, { timeout: 8_000 });
      const L = (await api.link(url))!;
      const old = (await activeExtract(api, L.id))!;
      const r = row(page, "slow-preview.qa.example");

      await step("Activity → Extract context → ✕ while it fetches the preview", "“Cancelled”");
      await openBatch(ctx, "Extract context");
      await click(jobRows(page).filter({ hasText: "slow-preview.qa.example" }).getByRole("button", { name: "Cancel", exact: true }));
      await toastSeen(expect, page, "Cancelled");
      await closeActivity(ctx);

      await step("Right away: row menu → Extract context", "The row reads “Extracting…” and stays processing until the new job ends");
      await click(r.getByRole("button", { name: "Link actions" }));
      await click(page.getByRole("menuitem", { name: "Extract context", exact: true }));
      await expect("API: a new extraction is active and the old job is Cancelled", async () => {
        const n = await activeExtract(api, L.id);
        return n && n.id !== old.id && cancelled((await jobsOf(api, L.id, "extract")).find((j) => j.id === old.id));
      }, { timeout: 8_000 });
      const fresh = (await activeExtract(api, L.id))!;
      await expect.visible(badge(r, "Extracting…"), "Row: “Extracting…”");

      await step("While it runs, select the link", "Auto-tag and Lens stay enabled for it");
      await click(r.getByRole("checkbox"));
      await expect("Auto-tag and Lens are enabled", async () =>
        (await bar(page).getByRole("button", { name: "Auto-tag", exact: true }).isEnabled()) && (await bar(page).getByRole("button", { name: "Lens", exact: true }).isEnabled()), { timeout: 5_000 });
      await click(r.getByRole("checkbox"));

      await whileRunning(expect, "Polled every 0.4 s until the new job ends: processing, content_state “queued”, never in Needs attention",
        async () => !ACTIVE.includes((await jobsOf(api, L.id, "extract")).find((j) => j.id === fresh.id)?.status),
        async () => {
          const l = await byId(api, L.id);
          const j = (await jobsOf(api, L.id, "extract")).find((x) => x.id === fresh.id);
          if (!ACTIVE.includes(j?.status)) return null;
          if (!l.processing || l.content_state !== "queued") return `while the new job was ${j?.status}: processing=${l.processing}, content_state=${l.content_state}`;
          return l.attention_kind ? `flagged ${l.attention_kind}` : null;
        }, 40_000);
      await expect("API: the new job is done and the link is ready; the old job is still Cancelled", async () => {
        const l = await byId(api, L.id);
        const jobs = await jobsOf(api, L.id, "extract");
        return jobs.find((j) => j.id === fresh.id)?.status === "done" && cancelled(jobs.find((j) => j.id === old.id))
          && !l.processing && l.content_state === "ready" && l.status === "ready" && !l.attention_kind;
      });
      await expect.visible(row(page, "Slow preview article cj-07/page"), "The row shows its title");
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),

    scenario("CJ-02", "CJ-02: cancelling a running re-extract keeps the previous content and its version", {
      ticket: "FAC-55 (AC1)",
      covers: "CJ-02: a link with pasted content “QA v1” is re-extracted and the job cancelled while it fetches the preview.",
      expected: "The Inspector still shows “QA v1” and “Updating extraction…” goes away; content_version is unchanged; the link is not in Needs attention.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: a link with pasted content “QA v1” (its own import was cancelled)", "Content ready, manual");
      const url = fixture("slow-preview", "page");
      const N = await neutralLink(ctx, url);
      await api.send("PUT", `/links/${N.id}/content`, { markdown: "QA v1" });
      await expect("Setup: content “QA v1”, ready", async () => (await content(api, N.id)) === "QA v1" && (await byId(api, N.id)).content_state === "ready");
      const before = await byId(api, N.id);
      await page.reload();
      const r = row(page, "slow-preview.qa.example");

      await step("Open it in the Inspector, then row menu → Re-extract context", "“Updating extraction… showing saved content”");
      await click(r.locator("p").first());
      await click(page.getByRole("tab", { name: "Content" }));
      await expect.visible(page.getByText("QA v1", { exact: true }), "Inspector: “QA v1”");
      await click(r.getByRole("button", { name: "Link actions" }));
      await click(page.getByRole("menuitem", { name: "Re-extract context" }));
      const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "Extract context for 1 link?" });
      await click(confirm.getByRole("button", { name: "Extract", exact: true }));
      await expect.visible(page.getByText("Updating extraction… showing saved content", { exact: true }), "Inspector: “Updating extraction… showing saved content”");

      await step("Activity → Extract context → ✕ while it fetches the preview", "“Cancelled”");
      await openBatch(ctx, "Extract context");
      const job = (await activeExtract(api, N.id))!;
      await expect("API: the re-extract is fetching the preview", async () => (await activeExtract(api, N.id))?.step === "Fetching preview");
      await click(jobRows(page).filter({ hasText: "slow-preview.qa.example" }).first().getByRole("button", { name: "Cancel", exact: true }));
      await toastSeen(expect, page, "Cancelled");
      await expect("API: the re-extract is Cancelled", async () => cancelled((await jobsOf(api, N.id, "extract")).find((j) => j.id === job.id)));
      await closeActivity(ctx);

      await step("Look at the Inspector", "Still “QA v1”; content and version unchanged; not in Needs attention");
      await expect("API: content key, version and source unchanged, content ready, not processing, no attention", async () => {
        const l = await byId(api, N.id);
        return l.content_key === before.content_key && l.content_version === before.content_version && l.content_source === "manual"
          && l.content_state === "ready" && !l.processing && !l.attention_kind;
      }, { timeout: 8_000 });
      await expect("GET /content: still “QA v1”", async () => (await content(api, N.id)) === "QA v1");
      if (!(await page.getByText("QA v1", { exact: true }).isVisible())) {
        await click(r.locator("p").first());
        await click(page.getByRole("tab", { name: "Content" }));
      }
      await expect.visible(page.getByText("QA v1", { exact: true }), "Inspector: “QA v1”");
      await expect.hidden(page.getByText("Updating extraction… showing saved content"), "No “Updating extraction…” any more");
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),

    scenario("CJ-03", "CJ-03 + CJ-05: ✕ on a waiting auto-tag takes only that job; the lens still runs after", {
      ticket: "FAC-55 · FAC-53",
      covers: "CJ-03: cancel a waiting Jev job; the next one is promoted. CJ-05: a Jev job cancelled before its call is a plain “Cancelled” with no Usage row.",
      expected: "Auto-tag, Auto-tag again, then Lens on a link whose Jev takes 20 s. ✕ the second auto-tag: toast “Cancelled”, only it reads “Cancelled”. The first auto-tag finishes, then the lens runs. Usage: 2 Jev rows, none for the cancelled job.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: the tag, the lens, and a link whose content makes Jev take 20 s (“jev:slow=20000 jev:yes”)", "A ready link");
      await ensureTagAndLens(api);
      const L = await readyLink(ctx, fixture("article", "slow-jev"), "QA slow Jev jev:slow=20000 jev:yes");
      await page.reload();
      const r = row(page, L.title);

      await step("Select it: Auto-tag; again: Auto-tag; again: Lens → “QA lens”", "The first auto-tag runs; the second and the lens wait");
      await click(r.getByRole("checkbox"));
      await barButton(ctx, "Auto-tag");
      await click(r.getByRole("checkbox"));
      await barButton(ctx, "Auto-tag");
      await click(r.getByRole("checkbox"));
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(LENS) }));
      await expect("API: auto-tag 1 running; auto-tag 2 and the lens waiting", async () => {
        const [t1, t2] = await jobsOf(api, L.id, "autotag"), [l] = await jobsOf(api, L.id, "lens");
        return t1?.status === "running" && t2?.status === "waiting" && l?.status === "waiting";
      }, { timeout: 8_000 });
      const [, second] = await jobsOf(api, L.id, "autotag");

      await step("Activity → the newest Auto-tag batch → ✕ on the waiting job", "Toast “Cancelled”; only that job goes");
      await openBatch(ctx, "Auto-tag");
      const card = batchCard(page, "Auto-tag").first();
      await expect("API: right before the click, the second auto-tag is still waiting", async () =>
        (await jobsOf(api, L.id, "autotag")).find((j) => j.id === second.id)?.status === "waiting");
      await expect.visible(card.locator("div.rounded-md").filter({ hasText: L.title }), "The batch holds the waiting auto-tag");
      await click(card.locator("div.rounded-md").filter({ hasText: L.title }).getByRole("button", { name: "Cancel", exact: true }));
      await toastSeen(expect, page, "Cancelled");
      await expect("API: only the second auto-tag is Cancelled, with the plain error “Cancelled”; the first still runs, the lens still waits", async () => {
        const [t1, t2] = await jobsOf(api, L.id, "autotag"), [l] = await jobsOf(api, L.id, "lens");
        return t2?.id === second.id && cancelled(t2) && t2.error === "Cancelled" && t1?.status === "running" && l?.status === "waiting";
      });
      await expect.visible(card.getByText("Cancelled", { exact: true }).first(), "Activity: it reads “Cancelled”");

      await step("Wait", "The first auto-tag finishes, then the lens runs");
      await whileRunning(expect, "Polled every 0.4 s until the lens is done: the lens never runs while the first auto-tag is active",
        async () => (await jobsOf(api, L.id, "lens"))[0]?.status === "done",
        async () => {
          const [t1] = await jobsOf(api, L.id, "autotag"), [l] = await jobsOf(api, L.id, "lens");
          return ACTIVE.includes(t1?.status) && l?.status === "running" ? "the lens ran during the first auto-tag" : null;
        }, 60_000);
      await expect("API: the first auto-tag is done and tagged the link; the lens result is stored", async () => {
        const [t1] = await jobsOf(api, L.id, "autotag");
        const l = await byId(api, L.id), lid = await lensId(api);
        return t1?.status === "done" && l.tags.some((t: any) => t.name === TAG) && l.lens_results.some((x: any) => x.lens_id === lid);
      });
      await expect("Usage: 2 Jev rows for the link (auto-tag 1 and the lens), none for the cancelled job", async () => {
        const rows = await jevUsage(api, L.id);
        return rows.length === 2 && !rows.some((e) => e.job_id === second.id);
      });
      await closeActivity(ctx);
    }),

    scenario("CJ-04", "CJ-04 + CJ-10: ✕ on a Lens during its Jev call says it may have been billed; nothing is resent", {
      ticket: "FAC-55 (AC1)",
      covers: "CJ-04: cancelling a paid call in flight. CJ-10: a batch with one cancelled and one done job does not say “failed” and offers no Retry.",
      expected: "Lens on two links; one Jev call takes 30 s. ✕ it while “Evaluating with Jev”: “Cancelled after calling Jev (may have been billed).”, a failed Usage row, no lens result. The batch reads Done (1 done, 1 cancelled, 0 failed). A recovery tick resends nothing.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: the lens, a link whose Jev call takes 30 s (“jev:slow=30000 jev:yes”) and a quick one", "Two ready links");
      await ensureTagAndLens(api);
      const S = await readyLink(ctx, fixture("article", "slow-lens"), "QA slow lens jev:slow=30000 jev:yes");
      const Q = await readyLink(ctx, fixture("article", "quick-lens"), "QA quick lens jev:yes");
      await page.reload();

      await step("Select both and apply the lens “QA lens”", "The quick one is done; the slow one is “Evaluating with Jev”");
      await click(row(page, S.title).getByRole("checkbox"));
      await click(row(page, Q.title).getByRole("checkbox"));
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(LENS) }));
      await expect("API: the quick lens is done; the slow one is running with its Jev call sent (a Usage row started)", async () => {
        const [q] = await jobsOf(api, Q.id, "lens"), [s] = await jobsOf(api, S.id, "lens");
        return q?.status === "done" && s?.status === "running" && s.step === "Evaluating with Jev" && (await jevUsage(api, S.id)).length === 1;
      }, { timeout: 10_000 });
      const [job] = await jobsOf(api, S.id, "lens");

      await step("Activity → Lens: QA lens → ✕ on the slow link while Jev answers", "“Cancelled after calling Jev (may have been billed).”");
      await openBatch(ctx, `Lens: ${LENS}`);
      const jr = jobRows(page).filter({ hasText: S.title });
      await expect.visible(jr.getByText("Evaluating with Jev").first(), "Activity: “Evaluating with Jev”");
      await click(jr.getByRole("button", { name: "Cancel", exact: true }));
      await toastSeen(expect, page, "Cancelled");
      await expect(`API: the job is Cancelled with “${BILLED}”`, async () => {
        const [s] = await jobsOf(api, S.id, "lens");
        return cancelled(s) && s.error === BILLED;
      });
      await expect.visible(jr.getByText(BILLED, { exact: true }), `Activity: “${BILLED}”`);
      await expect("Usage: one Jev row for the slow link, marked failed", async () => {
        const rows = await jevUsage(api, S.id);
        return rows.length === 1 && rows[0].status === "failed";
      }, { timeout: 5_000 });
      const lid = await lensId(api);
      await expect("API: no lens result for the slow link; the quick link has one", async () =>
        !(await byId(api, S.id)).lens_results.some((x: any) => x.lens_id === lid) && (await byId(api, Q.id)).lens_results.some((x: any) => x.lens_id === lid));

      await step("CJ-10: look at the batch", "1 done, 1 cancelled: it reads Done, with no “failed” count and no Retry");
      const card = batchCard(page, `Lens: ${LENS}`).first();
      await expect("API: the batch counts done 1, cancelled 1, failed 0", async () => {
        const b = (await api.library()).batches.find((x: any) => x.kind === "lens");
        return b && !b.active && b.done === 1 && b.cancelled === 1 && b.failed === 0;
      });
      await expect.visible(card.getByText("Done", { exact: true }), "The batch reads “Done”");
      await expect("No “failed” badge and no Retry on the batch or the cancelled job", async () =>
        !(await card.getByText(/failed/).count()) && !(await card.getByRole("button", { name: /^Retry/ }).count()));
      await toastSeen(expect, page, "Lens applied to 1 link");
      await closeActivity(ctx);

      await step("Run a recovery tick and wait 8 s", "Nothing is resent: still one Usage row, no lens result, the job stays cancelled");
      await expect("Recovery tick ran", recoveryTick);
      await expect.holds("One Jev Usage row, no lens result, the job still Cancelled, no new job", 8_000, async () => {
        const jobs = await jobsOf(api, S.id, "lens");
        return (await jevUsage(api, S.id)).length === 1 && jobs.length === 1 && cancelled(jobs[0]) && jobs[0].id === job.id
          && !(await byId(api, S.id)).lens_results.some((x: any) => x.lens_id === lid);
      });
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),

    scenario("CJ-06", "CJ-06: a job that already finished can't be cancelled", {
      ticket: "FAC-55",
      covers: "CJ-06: DELETE /api/jobs/<id> on a finished job, and on an unknown id.",
      expected: "The finished job answers 409 “This job already finished.” and stays done; an unknown id answers 404.",
    }, async (ctx) => {
      const { page, step, expect, api, fixture } = ctx;
      await step("Setup: a link whose extraction already finished", "One done job");
      const url = fixture("article", "done");
      await api.send("POST", "/import", { urls: [url] });
      await expect("Setup: the extraction is done", async () => (await api.jobs(url))[0]?.status === "done", { timeout: 20_000 });
      await page.reload();
      const job = (await api.jobs(url))[0];

      await step("Cancel the finished job through the API, then an unknown id", "409 “This job already finished.”; 404 for the unknown id");
      const a = await raw("DELETE", `/jobs/${job.id}`);
      const b = await raw("DELETE", "/jobs/no-such-job");
      await terminal(page, [
        `$ curl -X DELETE /api/jobs/${job.id}`, `HTTP ${a.status}`, JSON.stringify({ error: a.error }), "",
        "$ curl -X DELETE /api/jobs/no-such-job", `HTTP ${b.status}`, JSON.stringify({ error: b.error }),
      ]);
      await expect(`DELETE finished job → 409 “${FINISHED}”`, () => a.status === 409 && a.error === FINISHED);
      await expect("DELETE unknown id → 404", () => b.status === 404);
      await expect("API: the job is still done", async () => (await api.jobs(url))[0]?.status === "done");
      await page.evaluate(() => document.getElementById("qa-terminal")?.remove());
    }),

    scenario("NA-29", "NA-29 + CJ-09 + NA-26: cancelling a retry leaves a Needs attention link exactly as it was", {
      ticket: "FAC-48 · FAC-55",
      covers: "NA-29 / CJ-09: a content-only Retry held behind a slow page is cancelled with its ✕; the row returns to “Context failed” with the same reason, never neutral. NA-26: while the retry is held, no Retry/Use preview/Dismiss and the API refuses.",
      expected: "While held: no inline Retry, Use preview or Dismiss, and POST /retry answers “Wait for the running job to finish.”. After the ✕: “Cancelled”; the row reads “Couldn't get the content: The page returned no content…” with Context failed, and Needs attention stays at 1 the whole time.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: an empty page whose extraction failed (content attention)", "Needs attention (1)");
      const url = fixture("empty-page", "failed");
      await api.send("POST", "/import", { urls: [url] });
      await expect("Setup: content failed, attention “empty”", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.content_state === "failed" && l.attention_kind === "content" && l.attention_reason === "empty";
      }, { timeout: 30_000 });
      const E = (await api.link(url))!;
      await page.reload();

      await step("Add a slow page: it holds the only browser slot for about 28 s", "It is extracting");
      await addLinks(ctx, fixture("slow-ok", "holder"));
      await expect.visible(toast(page, "Link saved"), "Toast: Link saved");

      await step("Needs attention → Retry on the empty page", "Its content-only retry waits for the browser slot; the row stays listed");
      await click(attentionNav(page));
      const r = row(page, E.title);
      await expect.visible(r.getByText(EMPTY, { exact: true }), `Row: “${EMPTY}”`);
      await click(r.getByRole("button", { name: "Retry", exact: true }));
      await expect("API: the retry is running (waiting for the slot) and the link keeps its attention", async () => {
        const j = await activeExtract(api, E.id);
        const l = await byId(api, E.id);
        return j?.status === "running" && j.step === "Preparing content" && l.attention_kind === "content" && l.attention_reason === "empty";
      }, { timeout: 8_000 });
      const retry = (await activeExtract(api, E.id))!;

      await step("NA-26: while it is held, look at the row and try Retry through the API", "No Retry, Use preview or Dismiss; the API answers “Wait for the running job to finish.”");
      await expect("Row: no Retry / Use preview / Dismiss", async () => !(await r.getByRole("button", { name: /^(Retry|Use preview|Dismiss)$/ }).count()), { timeout: 5_000 });
      const reply = await raw("POST", `/links/${E.id}/retry`, { step: "content" });
      await terminal(page, [`$ curl -X POST /api/links/${E.id}/retry -d '{"step":"content"}'`, `HTTP ${reply.status}`, JSON.stringify({ error: reply.error })]);
      await expect(`API POST /retry → 400 “${BUSY}”`, () => reply.status === 400 && reply.error === BUSY);
      await expect("API: still exactly one active job on the link", async () => (await allJobs(api)).filter((j) => j.link_id === E.id && ACTIVE.includes(j.status)).length === 1);
      await page.evaluate(() => document.getElementById("qa-terminal")?.remove());

      await step("CJ-09: Activity → the retry's Extract context batch → ✕ on its job", "“Cancelled”; the link goes back to how it was");
      await openBatch(ctx, "Extract context");
      await click(batchCard(page, "Extract context").first().locator("div.rounded-md").filter({ hasText: E.title }).getByRole("button", { name: "Cancel", exact: true }));
      await toastSeen(expect, page, "Cancelled");
      await whileRunning(expect, "Polled every 0.4 s until it is cancelled: the link never leaves Needs attention",
        async () => cancelled((await jobsOf(api, E.id, "extract")).find((j) => j.id === retry.id)),
        async () => {
          const l = await byId(api, E.id);
          return l.attention_kind === "content" && l.attention_reason === "empty" ? null : `attention became ${l.attention_kind}/${l.attention_reason}`;
        }, 10_000);
      await closeActivity(ctx);

      await step("Look at the row", "Same reason, Context failed, Retry offered; Needs attention still (1)");
      await expect.holds("For 4 s: content attention “empty”, content failed, not processing (never neutral)", 4_000, async () => {
        const l = await byId(api, E.id);
        return l.attention_kind === "content" && l.attention_reason === "empty" && l.content_state === "failed" && !l.processing;
      });
      await expect.visible(r.getByText(EMPTY, { exact: true }), `Row: “${EMPTY}”`);
      await expect.visible(badge(r, "Context failed"), "Badge: Context failed");
      await expect.visible(r.getByRole("button", { name: "Retry", exact: true }), "Retry is offered again");
      await expect("Sidebar: Needs attention (1)", async () => /1\s*$/.test(await attentionNav(page).innerText()));
    }),
  ],
});
