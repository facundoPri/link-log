// Chapter 4 "Jev waits its turn" (FAC-53 per-link job queue): planning/qa/fac-48-test-plan.md §12 and §7 (PQ-*), §8 (X-01, X-02).
// Profile FIX-SLOT1: fixture Jev and one browser slot, so an extraction lasts long enough to queue Jev work behind it.
// Setup that is not the point of a scenario (the tag, the lens, links with pasted content, neutral links from a
// cancelled import) goes through the API; everything the captions talk about happens in the UI.
import type { Locator, Page } from "playwright-core";
import { chapter, scenario, type Api, type Expect, type ScenarioContext } from "../recorder";
import { API } from "../env";

type Ctx = Pick<ScenarioContext, "page" | "click" | "paste" | "expect" | "api" | "step" | "hover">;

const attentionNav = (page: Page) => page.locator("aside").getByRole("button", { name: /Needs attention/ });
const allLinksNav = (page: Page) => page.locator("aside").getByRole("button", { name: /^All links/ });
const settingsNav = (page: Page) => page.locator("aside").getByRole("button", { name: "Settings", exact: true });
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

const TAG = "qa tag"; // "QA tag", stored lowercase
const LENS = "QA lens";
const MISSING = "Content missing. Extract it first.";
const EMPTY = "Couldn't get the content: The page returned no content. You can paste it manually.";
const WALL = "Couldn't get the content: Got a login page instead of the content.";
const SETTING = "If the content can't be extracted, use the preview for Jev";
const ACTIVE = ["queued", "running", "waiting"];

/** Every job in the library (all batches), with its batch kind. */
async function allJobs(api: Api) {
  const lib = await api.library();
  const details = await Promise.all((lib.batches ?? []).map(async (b: any) => ({ b, jobs: ((await api.get(`/batches/${b.id}`)) as any).jobs ?? [] })));
  return details.flatMap(({ b, jobs }) => jobs.map((j: any) => ({ ...j, kind: b.kind as string })));
}
/** The jobs of one kind on one link, oldest first. */
const jobsOf = async (api: Api, linkId: string, kind: string) =>
  (await allJobs(api)).filter((j) => j.link_id === linkId && j.kind === kind).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

/**
 * 53-AC3 and FIFO: no link ever has two queued/running jobs, and no Jev job of a link is queued or running while an
 * older job on that link (its extraction, or the auto-tag before a lens) is still active. Returns what broke, or null.
 */
async function queueInvariant(api: Api, linkIds: string[]): Promise<string | null> {
  const jobs = await allJobs(api);
  for (const id of linkIds) {
    const mine = jobs.filter((j) => j.link_id === id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const live = mine.filter((j) => j.status === "queued" || j.status === "running");
    if (live.length > 1) return `two active jobs on one link: ${live.map((j) => `${j.kind}:${j.status}`).join(", ")}`;
    for (const [i, j] of mine.entries())
      if ((j.status === "queued" || j.status === "running") && mine.slice(0, i).some((o) => ACTIVE.includes(o.status)))
        return `${j.kind} started while an older ${mine.slice(0, i).find((o) => ACTIVE.includes(o.status))!.kind} job was still active`;
  }
  return null;
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

/** Jev rows in Usage for a link (fake Browser calls are metered as cloudflare/browser-markdown and are not Jev). */
const jevUsage = async (api: Api, linkId: string) =>
  ((await api.get<{ events: any[] }>("/usage")).events ?? []).filter((e) => e.link_id === linkId && !/browser/i.test(`${e.provider} ${e.service} ${e.operation}`));
const content = async (api: Api, id: string) => (await api.get<{ markdown: string }>(`/links/${id}/content`)).markdown;
const tagId = async (api: Api) => (await api.library()).tags.find((t: any) => t.name === TAG)?.id as string;
const tagged = (l: any) => l.tags.some((t: any) => t.name === TAG);
const evaluated = async (api: Api, linkId: string) => {
  const id = await tagId(api);
  return (await api.library()).links.find((l) => l.id === linkId)?.evaluations.find((e: any) => e.tag_id === id);
};
const byId = async (api: Api, id: string) => (await api.library()).links.find((l) => l.id === id)!;

/** Setup: the tag "QA tag" (and the lens "QA lens"); both survive the runner's reset, so creating them is idempotent. */
async function ensureTagAndLens(api: Api, lens = false) {
  await api.send("POST", "/tags", { name: "QA tag" });
  if (lens) await api.send("POST", "/lenses", { name: LENS, type: "noul", question: "Is this a QA article?" }).catch(() => {}); // 409 when it exists
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

/** Setup: links imported and cancelled at once, so they are neutral (no preview, no content, not processing, no attention). */
async function neutralLinks({ expect, api }: Pick<Ctx, "expect" | "api">, urls: string[]) {
  await api.send("POST", "/import", { urls });
  for (const url of urls)
    await expect(`Setup: ${new URL(url).host.split(".")[0]} import cancelled, the link is neutral`, async () => {
      const l = await api.link(url);
      if (!l) return false;
      for (const j of (await jobsOf(api, l.id, "extract")).filter((j) => ACTIVE.includes(j.status)))
        await api.send("DELETE", `/jobs/${j.id}`).catch(() => {});
      const now = await api.link(url);
      return now && !now.processing && now.content_state === "missing" && !now.content_key && !now.attention_kind;
    }, { timeout: 20_000 });
  return Promise.all(urls.map(async (u) => (await api.link(u))!));
}

/** Opens Add link, pastes `text` and saves. */
async function addLinks({ page, click, paste }: Pick<Ctx, "page" | "click" | "paste">, text: string) {
  await click(page.getByRole("button", { name: "Add link" }));
  await paste(page.getByRole("textbox"), text);
  await click(page.getByRole("button", { name: /^Save/ }));
}

async function pick({ click }: Pick<Ctx, "click">, rows: Locator[]) {
  for (const r of rows) await click(r.getByRole("checkbox"));
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

/** Settings → sets the preview fallback checkbox, checks UI and API, closes. */
async function setFallback({ page, click, expect, api }: Pick<Ctx, "page" | "click" | "expect" | "api">, on: boolean) {
  await click(settingsNav(page));
  const box = page.getByRole("checkbox", { name: SETTING });
  await expect.visible(box, "Settings is open");
  if ((await box.isChecked()) !== on) await click(box);
  await expect(`Settings: the fallback is ${on ? "on" : "off"} (checkbox and API)`, async () =>
    (await box.isChecked()) === on && (await api.library()).settings?.preview_fallback === on, { timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect.hidden(page.getByRole("dialog", { name: "Settings" }), "Settings closed");
}

/** Runs the scheduled recovery (what cron does every 30 s): promotes orphaned waiting jobs and resends queued ones. */
const recoveryTick = () => fetch(`${API}/cdn-cgi/local/scheduled`).then((r) => r.ok);

export default chapter({
  id: "ch4-jev-waits",
  title: "Jev waits its turn",
  ticket: "FAC-53",
  summary: [
    "Auto-tag on a mixed selection: links with content are tagged now, links still extracting wait for it, then tag",
    "A lens applied during an auto-tag waits for it; a link never runs two jobs at once",
    "Links without content: Lens explains why it is off, Auto-tag offers to extract them first",
    "A failed extraction ends the waiting auto-tag as “Content missing”, for free and outside Needs attention",
    "Cancelling the waiting Jev work, or the extraction it waits for",
    "Login walls: with the fallback the auto-tag reads the preview; without it, Use preview then auto-tag",
  ],
  env: { vars: { BROWSER_CONCURRENCY: "1" } },
  scenarios: [
    scenario("PQ-01", "PQ-01: a mixed selection — links with content tag now, links still extracting wait, then tag", {
      ticket: "FAC-53 (AC1, AC3)",
      covers: "PQ-01 (53-AC1): ready links run now, extracting links run when their extraction ends. 53-AC3: no link ever has two active jobs.",
      expected: "Auto-tag on 4 links: the 2 with content are done at once; the 2 still extracting read “Waiting for extraction” and are tagged after it. Never two active jobs on a link.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: the tag “QA tag” and two links with pasted content (“jev:yes” and “jev:no”)", "Two ready links");
      await ensureTagAndLens(api);
      const A = await readyLink(ctx, fixture("article", "ready-a"), "QA ready A jev:yes");
      const B = await readyLink(ctx, fixture("article", "ready-b"), "QA ready B jev:no");
      await page.reload();

      await step("Add two new links: a slow page, then a quick one (only one page renders at a time)", "Both are saved and start extracting");
      const slowUrl = fixture("slow-yes", "slow"), quickUrl = fixture("article-yes", "quick");
      await addLinks(ctx, `${slowUrl}\n${quickUrl}`);
      await expect.visible(toast(page, "2 links saved"), "Toast: 2 links saved");
      await expect("API: both new links are extracting (processing, content queued)", async () => {
        const ls = await Promise.all([api.link(slowUrl), api.link(quickUrl)]);
        return ls.every((l) => l && l.processing && l.content_state === "queued");
      }, { timeout: 8_000 });
      const S = (await api.link(slowUrl))!, Q = (await api.link(quickUrl))!;
      const rows = { a: row(page, A.title), b: row(page, B.title), s: row(page, "slow-yes.qa.example"), q: row(page, "article-yes.qa.example") };

      await step("Select all four and click Auto-tag", "No dialog: every link has content or an extraction on the way");
      await pick(ctx, [rows.a, rows.b, rows.s, rows.q]);
      await expect.visible(bar(page).getByText("4 selected", { exact: true }), "Selection bar: 4 selected");
      await barButton(ctx, "Auto-tag");
      await expect.hidden(page.getByRole("alertdialog"), "No “no content” dialog");
      await expect("API: A and B done at once; the two new links wait (status waiting, waiting_for extract)", async () => {
        const jobs = await allJobs(api);
        const at = (id: string) => jobs.find((j) => j.kind === "autotag" && j.link_id === id);
        return at(A.id)?.status === "done" && at(B.id)?.status === "done" && [S.id, Q.id].every((id) => at(id)?.status === "waiting" && at(id)?.waiting_for === "extract");
      }, { timeout: 10_000 });
      await expect("API: the extracting links are still processing, not failed", async () =>
        [await byId(api, S.id), await byId(api, Q.id)].every((l) => l.processing && l.status !== "failed" && !l.attention_kind));
      await expect.visible(rows.q.getByText("Extracting…", { exact: true }), "The waiting row shows “Extracting…”");

      await step("Open Activity → Auto-tag", "Two jobs done, two read “Waiting for extraction” with a clock");
      await openBatch(ctx, "Auto-tag");
      await expect("Activity: exactly two jobs read “Waiting for extraction”", async () =>
        (await activity(page).getByText("Waiting for extraction", { exact: true }).count()) === 2);
      await expect("Activity: the two ready links are done (no spinner, no Cancel)", async () =>
        (await jobRows(page).filter({ hasText: A.title }).getByRole("button", { name: "Cancel" }).count()) === 0 &&
        (await jobRows(page).filter({ hasText: B.title }).getByRole("button", { name: "Cancel" }).count()) === 0);

      await step("Wait for the extractions to end", "Each waiting auto-tag runs by itself right after its extraction; never two jobs at once on a link");
      await whileRunning(expect, "Polled every 0.4 s: never two active jobs on a link, no auto-tag before its extraction ends",
        async () => (await allJobs(api)).filter((j) => j.kind === "autotag").every((j) => j.status === "done"),
        () => queueInvariant(api, [A.id, B.id, S.id, Q.id]), 60_000);
      await expect("API: both new links extracted (content ready)", async () =>
        [await byId(api, S.id), await byId(api, Q.id)].every((l) => !l.processing && l.content_state === "ready"));
      await expect("API: all four were evaluated; A, the slow and the quick link got “qa tag”, B (jev:no) did not", async () => {
        const lib = await api.library();
        const get = (id: string) => lib.links.find((l) => l.id === id)!;
        const tid = lib.tags.find((t: any) => t.name === TAG)?.id;
        const ev = (id: string) => get(id).evaluations.some((e: any) => e.tag_id === tid);
        return [A.id, B.id, S.id, Q.id].every(ev) && tagged(get(A.id)) && tagged(get(S.id)) && tagged(get(Q.id)) && !tagged(get(B.id));
      });
      await expect("Activity: no job is waiting any more", async () => (await activity(page).getByText("Waiting for extraction").count()) === 0);
      await closeActivity(ctx);
      for (const [name, r] of [["slow", row(page, "Slow tagged article pq-01/slow")], ["quick", row(page, "Taggable article pq-01/quick")], ["A", rows.a]] as const)
        await expect.visible(r.getByText(TAG, { exact: true }), `Row ${name} shows the tag “qa tag”`);
      await expect.hidden(rows.b.getByText(TAG, { exact: true }), "Row B has no tag");
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),

    scenario("PQ-05", "PQ-05: a lens applied during an auto-tag waits for it, then runs", {
      ticket: "FAC-53 (AC3)",
      covers: "PQ-05 (53-AC3, per-link FIFO): Auto-tag, then immediately a lens on the same link; the lens waits for the auto-tag.",
      expected: "The lens job reads “Waiting for auto-tag” while Jev answers the auto-tag (8 s), then runs and shows its verdict. The link never has two active jobs.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: the tag, the lens “QA lens”, and a link whose content makes Jev take 8 s (“jev:slow=8000 jev:yes”)", "A ready link");
      await ensureTagAndLens(api, true);
      const L = await readyLink(ctx, fixture("article", "slow-jev"), "QA slow Jev jev:slow=8000 jev:yes");
      await page.reload();
      const r = row(page, L.title);

      await step("Select it and click Auto-tag", "The auto-tag runs (Jev takes 8 s)");
      await pick(ctx, [r]);
      await barButton(ctx, "Auto-tag");
      await expect("API: the auto-tag job is running", async () => (await jobsOf(api, L.id, "autotag"))[0]?.status === "running", { timeout: 8_000 });
      await expect.visible(r.getByText("Tagging…", { exact: true }), "Row: “Tagging…”");

      await step("Right away, select it again and apply the lens “QA lens”", "The lens job waits for the auto-tag");
      await pick(ctx, [r]);
      await barButton(ctx, "Lens");
      await click(page.getByRole("option", { name: new RegExp(LENS) }));
      await expect("API: the lens job is waiting (waiting_for autotag) while the auto-tag runs", async () => {
        const [lens] = await jobsOf(api, L.id, "lens");
        const [tag] = await jobsOf(api, L.id, "autotag");
        return lens?.status === "waiting" && lens.waiting_for === "autotag" && tag?.status === "running";
      }, { timeout: 5_000 });
      await openBatch(ctx, `Lens: ${LENS}`);
      await expect.visible(activity(page).getByText("Waiting for auto-tag", { exact: true }), "Activity → Lens: “Waiting for auto-tag”");

      await step("Wait", "The auto-tag finishes, then the lens runs; never two active jobs on the link");
      await whileRunning(expect, "Polled every 0.4 s: one active job at a time, the lens only after the auto-tag",
        async () => (await jobsOf(api, L.id, "lens"))[0]?.status === "done",
        () => queueInvariant(api, [L.id]), 40_000);
      await expect("API: the auto-tag is done and tagged the link; the lens has a result", async () => {
        const l = await byId(api, L.id);
        const lens = (await api.library()).lenses.find((x: any) => x.name === LENS);
        return (await jobsOf(api, L.id, "autotag"))[0]?.status === "done" && tagged(l) && l.lens_results.some((x: any) => x.lens_id === lens?.id);
      });
      await expect.visible(jobRows(page).filter({ hasText: L.title }).getByText("95%"), "Activity → Lens: the verdict (95%)");
      await expect.hidden(activity(page).getByText("Waiting for auto-tag"), "Nothing waits any more");
      await closeActivity(ctx);
    }),

    scenario("PQ-08", "PQ-08: Lens says why it is off when no selected link has content", {
      ticket: "FAC-53 (S6)",
      covers: "PQ-08: a lens needs content; with only neutral links selected it is disabled, with a mix it runs on the ones that have content.",
      expected: "Two neutral links: Lens disabled, tooltip “2 of 2 links need context first”. One ready + one neutral: Lens enabled, tooltip “1 of 2 links have no content and will be skipped”.",
    }, async (ctx) => {
      const { page, step, click, hover, expect, api, fixture } = ctx;
      await step("Setup: the lens, one link with content and two links whose import was cancelled (no content)", "Two neutral rows read “No preview yet”");
      await ensureTagAndLens(api, true);
      const R = await readyLink(ctx, fixture("article", "ready"), "QA ready jev:yes");
      await neutralLinks(ctx, [fixture("held-yes", "n1"), fixture("pool", "n2")]);
      await page.reload();
      const n1 = row(page, "held-yes.qa.example"), n2 = row(page, "pool.qa.example");
      await expect.visible(n1.getByText("No preview yet"), "Neutral row: “No preview yet”");

      await step("Select the two links without content and point at Lens", "Lens is disabled: “2 of 2 links need context first”");
      await pick(ctx, [n1, n2]);
      const lens = bar(page).getByRole("button", { name: "Lens", exact: true });
      await expect("Lens is disabled", async () => !(await lens.isEnabled()));
      await hover(lens);
      await expect.visible(page.getByText("2 of 2 links need context first").first(), "Tooltip: “2 of 2 links need context first”");

      await step("Swap one of them for the link with content and point at Lens again", "Lens is enabled: “1 of 2 links have no content and will be skipped”");
      await pick(ctx, [n2, row(page, R.title)]);
      await expect.visible(bar(page).getByText("2 selected", { exact: true }), "Still 2 selected (one neutral, one ready)");
      await expect("Lens is enabled", () => lens.isEnabled());
      await hover(lens);
      await expect.visible(page.getByText("1 of 2 links have no content and will be skipped").first(), "Tooltip: “1 of 2 links have no content and will be skipped”");
    }),

    scenario("PQ-02", "PQ-02: “Auto-tag 1 with content” skips the link without content", {
      ticket: "FAC-53 (AC1)",
      covers: "PQ-02 (53-AC1): a link whose extraction failed plus a ready link; Auto-tag explains, and “Auto-tag 1 with content” tags only the ready one and reports the skip.",
      expected: "Dialog “1 of 2 links have no content yet” with “Auto-tag reads the page content…”. After “Auto-tag 1 with content”: the toast “Skipped 1 link without content”, and only the ready link is tagged.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: one link with content, and an empty page whose extraction failed", "One ready link, one in Needs attention (content)");
      await ensureTagAndLens(api);
      const R = await readyLink(ctx, fixture("article", "ready"), "QA ready jev:yes");
      const emptyUrl = fixture("empty-page", "failed");
      await api.send("POST", "/import", { urls: [emptyUrl] });
      await expect("Setup: the empty page failed (content attention, no content)", async () => {
        const l = await api.link(emptyUrl);
        return l && !l.processing && l.content_state === "failed" && l.attention_kind === "content";
      }, { timeout: 30_000 });
      const E = (await api.link(emptyUrl))!;
      await page.reload();

      await step("Select both and click Auto-tag", "A dialog explains that one link has no content");
      await pick(ctx, [row(page, R.title), row(page, E.title)]);
      await barButton(ctx, "Auto-tag");
      const dialog = page.getByRole("alertdialog");
      await expect.visible(dialog.getByText("1 of 2 links have no content yet", { exact: true }), "Dialog: “1 of 2 links have no content yet”");
      await expect.visible(dialog.getByText("Auto-tag reads the page content. Extract it first and those links are auto-tagged as soon as it's ready, or auto-tag only the links that already have content."),
        "Dialog: “Auto-tag reads the page content. Extract it first … or auto-tag only the links that already have content.”");
      await expect.visible(dialog.getByRole("button", { name: "Extract, then auto-tag" }), "Dialog offers “Extract, then auto-tag”");

      await step("Click “Auto-tag 1 with content”", "Toast “Skipped 1 link without content”; only the ready link is tagged");
      // Watch for the toast from the click on: it can be gone by the time the API checks below are done.
      const skippedToast = toast(page, "Skipped 1 link without content").first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      await click(dialog.getByRole("button", { name: "Auto-tag 1 with content" }));
      await expect("API: one auto-tag job, for the ready link, done; it got “qa tag”", async () => {
        const jobs = (await allJobs(api)).filter((j) => j.kind === "autotag");
        return jobs.length === 1 && jobs[0].link_id === R.id && jobs[0].status === "done" && tagged(await byId(api, R.id));
      }, { timeout: 10_000 });
      await expect("API: the empty page has no auto-tag job and no evaluation", async () =>
        !(await jobsOf(api, E.id, "autotag")).length && !(await evaluated(api, E.id)));
      await expect.visible(row(page, R.title).getByText(TAG, { exact: true }), "The ready row shows “qa tag”");
      await expect("Toast: “Skipped 1 link without content”", async () => {
        if (await skippedToast) return true;
        throw new Error(`not shown within 10 s of the click (the client sent only the ready link, so the server skipped none); toasts now: ${
          (await page.locator("[data-sonner-toast]").allTextContents()).join(" | ") || "none"}`);
      }, { timeout: 1_000 });
    }),

    scenario("PQ-03", "PQ-03: “Extract, then auto-tag” extracts the link first, then tags it", {
      ticket: "FAC-53 (AC1)",
      covers: "PQ-03 (53-AC1, §7: Jev never starts an extraction by itself): the user asks for the extraction explicitly, and the auto-tag waits for it.",
      expected: "Activity shows a new Extract context batch and an Auto-tag batch whose job for that link reads “Waiting for extraction”. After the extraction it tags the link.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: one link with content, and one whose import was cancelled (no content)", "One ready link, one neutral");
      await ensureTagAndLens(api);
      const R = await readyLink(ctx, fixture("article", "ready"), "QA ready jev:yes");
      const [N] = await neutralLinks(ctx, [fixture("held-yes", "neutral")]);
      await page.reload();
      const nRow = row(page, "held-yes.qa.example");

      await step("Select both, click Auto-tag, then “Extract, then auto-tag”", "The neutral link is extracted, its auto-tag waits for it");
      await pick(ctx, [row(page, R.title), nRow]);
      await barButton(ctx, "Auto-tag");
      const dialog = page.getByRole("alertdialog");
      await expect.visible(dialog.getByText("1 of 2 links have no content yet", { exact: true }), "Dialog: “1 of 2 links have no content yet”");
      await click(dialog.getByRole("button", { name: "Extract, then auto-tag" }));
      await expect("API: a new extraction runs for the neutral link; its auto-tag waits for it; the ready link is done", async () => {
        const jobs = await allJobs(api);
        const extract = jobs.find((j) => j.kind === "extract" && j.link_id === N!.id && ACTIVE.includes(j.status));
        const at = (id: string) => jobs.find((j) => j.kind === "autotag" && j.link_id === id);
        return extract && at(N!.id)?.status === "waiting" && at(N!.id)?.waiting_for === "extract" && at(R.id)?.status === "done";
      }, { timeout: 8_000 });

      await step("Open Activity", "An Extract context batch and an Auto-tag batch with “Waiting for extraction”");
      await openBatch(ctx, "Auto-tag");
      await expect.visible(batchCard(page, "Extract context").first(), "Activity lists an Extract context batch");
      await expect.visible(activity(page).getByText("Waiting for extraction", { exact: true }), "Auto-tag: “Waiting for extraction”");

      await step("Wait for the extraction", "The auto-tag runs right after it and tags the link");
      await whileRunning(expect, "Polled every 0.4 s: no auto-tag before the extraction ends, one active job per link",
        async () => (await jobsOf(api, N!.id, "autotag"))[0]?.status === "done",
        () => queueInvariant(api, [N!.id, R.id]), 40_000);
      await expect("API: the link now has content and “qa tag”", async () => {
        const l = await byId(api, N!.id);
        return l.content_state === "ready" && !!l.content_key && tagged(l);
      });
      await closeActivity(ctx);
      await expect.visible(row(page, "Held article pq-03/neutral").getByText(TAG, { exact: true }), "Its row shows its title and “qa tag”");
    }),

    scenario("PQ-04", "PQ-04: the extraction fails, so the waiting auto-tag ends “Content missing”, for free", {
      ticket: "FAC-53 (AC2)",
      covers: "PQ-04 (53-AC2): a failed extraction resolves its waiting Jev job as content missing, without a provider call; X-03: the auto-tag failure is not in Needs attention.",
      expected: "The extraction fails (empty page) and the link enters Needs attention for its content only. The auto-tag ends “Content missing. Extract it first.”, and Usage has no Jev row for the link.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: an empty page whose import was cancelled (no content; the preview fallback is off)", "A neutral link");
      await ensureTagAndLens(api);
      const [N] = await neutralLinks(ctx, [fixture("empty-slow", "neutral")]);
      await page.reload();

      await step("Select it, click Auto-tag, then “Extract, then auto-tag”", "The auto-tag waits for the extraction");
      await pick(ctx, [row(page, "empty-slow.qa.example")]);
      await barButton(ctx, "Auto-tag");
      const dialog = page.getByRole("alertdialog");
      await expect.visible(dialog.getByText("1 of 1 link has no content yet", { exact: true }), "Dialog: “1 of 1 link has no content yet”");
      await expect.hidden(dialog.getByRole("button", { name: /with content/ }), "No “Auto-tag N with content” (nothing has content)");
      await click(dialog.getByRole("button", { name: "Extract, then auto-tag" }));
      await openBatch(ctx, "Auto-tag");
      await expect.visible(activity(page).getByText("Waiting for extraction", { exact: true }), "Activity → Auto-tag: “Waiting for extraction”");

      await step("Wait for the extraction (the page reader answers an empty page after 15 s)", "The auto-tag ends “Content missing. Extract it first.” without calling Jev");
      await whileRunning(expect, "Polled every 0.4 s: the auto-tag never starts while the extraction runs",
        async () => (await jobsOf(api, N!.id, "autotag"))[0]?.status === "failed",
        () => queueInvariant(api, [N!.id]), 40_000);
      await expect(`API: the auto-tag job failed with “${MISSING}”`, async () => (await jobsOf(api, N!.id, "autotag"))[0]?.error === MISSING);
      await expect.visible(activity(page).getByText(MISSING, { exact: true }), `Activity → Auto-tag: “${MISSING}”`);
      await expect("API: the extraction failed (empty); the link is in Needs attention for its content", async () => {
        const l = await byId(api, N!.id);
        return l.content_state === "failed" && l.attention_kind === "content" && l.attention_reason === "empty";
      });
      await expect("Usage: no Jev row for the link (Jev was never called)", async () => (await jevUsage(api, N!.id)).length === 0);
      await closeActivity(ctx);

      await step("Open Needs attention", "Only the extraction failure is listed, not the auto-tag");
      await click(attentionNav(page));
      await expect.visible(page.locator("main").getByText(EMPTY, { exact: true }), `Its row: “${EMPTY}”`);
      await expect("Needs attention (1): one row", async () => (await page.locator("main article").count()) === 1 && /1\s*$/.test(await attentionNav(page).innerText()));
      await expect.hidden(page.locator("main").getByText(MISSING), "The list does not mention the auto-tag");
    }),

    scenario("PQ-06", "PQ-06: cancelling the waiting auto-tag batch leaves the extractions alone", {
      ticket: "FAC-53 (S6)",
      covers: "PQ-06: Cancel batch on an auto-tag whose jobs wait for extractions.",
      expected: "The toast reads “Cancelled 2 queued jobs”, both jobs read “Cancelled”, the extractions finish normally and no auto-tag runs.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await ensureTagAndLens(api);
      await page.reload();
      await step("Add a slow page and a quick one", "Both extract, one at a time");
      const urls = [fixture("slow-yes", "slow"), fixture("article-yes", "quick")];
      await addLinks(ctx, urls.join("\n"));
      await expect.visible(toast(page, "2 links saved"), "Toast: 2 links saved");
      await expect("API: both are extracting", async () => (await Promise.all(urls.map((u) => api.link(u)))).every((l) => l?.content_state === "queued"), { timeout: 8_000 });
      const ids = (await Promise.all(urls.map((u) => api.link(u)))).map((l) => l!.id);

      await step("Select both and click Auto-tag", "Both auto-tag jobs wait for their extraction");
      await pick(ctx, [row(page, "slow-yes.qa.example"), row(page, "article-yes.qa.example")]);
      await barButton(ctx, "Auto-tag");
      await openBatch(ctx, "Auto-tag");
      await expect("Activity → Auto-tag: two jobs read “Waiting for extraction”", async () =>
        (await activity(page).getByText("Waiting for extraction", { exact: true }).count()) === 2);

      await step("Click Cancel batch on the Auto-tag batch", "“Cancelled 2 queued jobs”; both read “Cancelled”");
      await click(batchCard(page, "Auto-tag").first().getByRole("button", { name: "Cancel batch", exact: true }));
      await expect.visible(toast(page, "Cancelled 2 queued jobs"), "Toast: “Cancelled 2 queued jobs”");
      await expect("Activity: both auto-tag jobs read “Cancelled”", async () => (await activity(page).getByText("Cancelled", { exact: true }).count()) >= 2);
      await expect("API: both auto-tag jobs cancelled; the extractions still run", async () => {
        const jobs = await allJobs(api);
        return ids.every((id) => {
          const at = jobs.find((j) => j.kind === "autotag" && j.link_id === id);
          return at?.status === "failed" && at.step === "Cancelled";
        }) && jobs.some((j) => j.kind === "extract" && ACTIVE.includes(j.status));
      });
      await closeActivity(ctx);

      await step("Wait for the extractions", "They finish normally; nothing else runs");
      await expect("API: both links extracted normally (content ready)", async () =>
        (await Promise.all(ids.map((id) => byId(api, id)))).every((l) => !l.processing && l.content_state === "ready"), { timeout: 45_000 });
      await expect("API: no auto-tag ran — no evaluation, no tag, no Jev usage", async () => {
        for (const id of ids) if ((await evaluated(api, id)) || tagged(await byId(api, id)) || (await jevUsage(api, id)).length) return false;
        return (await allJobs(api)).filter((j) => j.kind === "autotag").every((j) => j.step === "Cancelled");
      });
      await expect.hidden(page.locator("main").getByText(TAG, { exact: true }), "No row shows “qa tag”");
    }),

    scenario("PQ-07", "PQ-07: cancelling the Extract context batch cancels the auto-tag waiting on it", {
      ticket: "FAC-53 · FAC-55",
      covers: "PQ-07: cancel the extraction batch while a slow page holds the browser slot; the Jev work waiting on it goes too.",
      expected: "Activity → Extract context → Cancel batch: “Cancelled 1 queued job, and 1 waiting for that extraction”. Both jobs read “Cancelled”, nothing runs later and the link stays neutral.",
    }, async (ctx) => {
      const { page, step, click, expect, api, fixture } = ctx;
      await step("Setup: a link whose import was cancelled (no content)", "A neutral link");
      await ensureTagAndLens(api);
      const [N] = await neutralLinks(ctx, [fixture("held-yes", "net")]);
      await page.reload();
      await step("Add a slow page: it holds the only browser slot for about 28 s", "It is extracting");
      await addLinks(ctx, fixture("slow-ok", "holder"));
      await expect.visible(toast(page, "Link saved"), "Toast: Link saved");

      await step("Select the neutral link: Auto-tag → “Extract, then auto-tag”", "Its extraction waits for the slot; the auto-tag waits for the extraction");
      await pick(ctx, [row(page, "held-yes.qa.example")]);
      await barButton(ctx, "Auto-tag");
      await click(page.getByRole("alertdialog").getByRole("button", { name: "Extract, then auto-tag" }));
      await expect("API: its extraction is pending and its auto-tag waits for it", async () => {
        const [e] = (await jobsOf(api, N!.id, "extract")).filter((j) => ACTIVE.includes(j.status));
        const [t] = await jobsOf(api, N!.id, "autotag");
        return e && t?.status === "waiting" && t.waiting_for === "extract";
      }, { timeout: 8_000 });

      await step("Activity → the new Extract context batch → Cancel batch", "“Cancelled 1 queued job, and 1 waiting for that extraction”");
      await openBatch(ctx, "Extract context");
      await expect.visible(jobRows(page).filter({ hasText: "held-yes.qa.example" }), "The batch holds the neutral link's extraction");
      const before = (await jobsOf(api, N!.id, "extract")).find((j) => ACTIVE.includes(j.status));
      await click(batchCard(page, "Extract context").first().getByRole("button", { name: "Cancel batch", exact: true }));
      const want = "Cancelled 1 queued job, and 1 waiting for that extraction";
      // Sonner stacks this toast behind the "Auto-tagging 1 link…" one, so look for it in the DOM rather than on top.
      // It lasts 4 s: once the other reply has been seen, keep reporting it.
      let nothing = false;
      await expect(`Toast: “${want}”`, async () => {
        if (await toast(page, want).count()) return true;
        nothing ||= (await toast(page, "Nothing left to cancel").count()) > 0;
        if (nothing)
          throw new Error(`the toast reads “Nothing left to cancel”: the extraction was ${before?.status} · ${before?.step} (waiting for the browser slot), and batch cancel only takes queued/waiting jobs`);
        return false;
      }, { timeout: 6_000 });
      await expect("API: the extraction and the auto-tag are both Cancelled", async () => {
        const e = (await jobsOf(api, N!.id, "extract")).at(-1), t = (await jobsOf(api, N!.id, "autotag"))[0];
        return e?.step === "Cancelled" && t?.step === "Cancelled";
      });
      await closeActivity(ctx);
      await step("Run a recovery tick and wait", "Nothing runs later; the link stays neutral");
      await expect("Recovery tick ran", recoveryTick);
      await expect.holds("The link stays neutral: no content, not processing, no attention, no Jev usage", 6_000, async () => {
        const l = await byId(api, N!.id);
        return !l.processing && l.content_state === "missing" && !l.attention_kind && !(await jevUsage(api, N!.id)).length;
      });
    }),

    scenario("PQ-07b", "PQ-07 (per job): cancelling the extraction with its ✕ cancels the auto-tag waiting on it", {
      ticket: "FAC-53 · FAC-55",
      covers: "PQ-07 cascade through the per-job ✕ (FAC-55), which also stops an extraction that already holds or waits for the browser slot.",
      expected: "The ✕ tooltip reads “Cancel (also cancels what waits for it)”. The toast reads “Cancelled, and 1 waiting for that extraction”, both jobs read “Cancelled”, nothing runs later and the link stays neutral.",
    }, async (ctx) => {
      const { page, step, click, hover, expect, api, fixture } = ctx;
      await step("Setup: a link whose import was cancelled (no content)", "A neutral link");
      await ensureTagAndLens(api);
      const [N] = await neutralLinks(ctx, [fixture("held-yes", "net")]);
      await page.reload();
      await step("Add a slow page: it holds the only browser slot for about 28 s", "It is extracting");
      await addLinks(ctx, fixture("slow-ok", "holder"));
      await expect.visible(toast(page, "Link saved"), "Toast: Link saved");

      await step("Select the neutral link: Auto-tag → “Extract, then auto-tag”", "Its extraction waits for the slot; the auto-tag waits for the extraction");
      await pick(ctx, [row(page, "held-yes.qa.example")]);
      await barButton(ctx, "Auto-tag");
      await click(page.getByRole("alertdialog").getByRole("button", { name: "Extract, then auto-tag" }));
      await expect("API: its extraction is pending and its auto-tag waits for it", async () => {
        const [e] = (await jobsOf(api, N!.id, "extract")).filter((j) => ACTIVE.includes(j.status));
        const [t] = await jobsOf(api, N!.id, "autotag");
        return e && t?.status === "waiting" && t.waiting_for === "extract";
      }, { timeout: 8_000 });

      await step("Activity → Extract context → ✕ on the link's extraction", "“Cancelled, and 1 waiting for that extraction”");
      await openBatch(ctx, "Extract context");
      const job = jobRows(page).filter({ hasText: "held-yes.qa.example" });
      const x = job.getByRole("button", { name: "Cancel", exact: true });
      await hover(x);
      await expect.visible(page.getByText("Cancel (also cancels what waits for it)").first(), "Tooltip: “Cancel (also cancels what waits for it)”");
      await click(x);
      await expect.visible(toast(page, "Cancelled, and 1 waiting for that extraction"), "Toast: “Cancelled, and 1 waiting for that extraction”");
      await expect.visible(job.getByText("Cancelled", { exact: true }).first(), "The extraction reads “Cancelled”");
      await expect("API: the extraction and the auto-tag are both Cancelled", async () => {
        const e = (await jobsOf(api, N!.id, "extract")).at(-1), t = (await jobsOf(api, N!.id, "autotag"))[0];
        return e?.step === "Cancelled" && t?.step === "Cancelled" && t.status === "failed";
      });
      await openBatch(ctx, "Auto-tag");
      await expect.visible(batchCard(page, "Auto-tag").first().getByText("Cancelled", { exact: true }).first(), "Activity → Auto-tag: “Cancelled”");
      await closeActivity(ctx);

      await step("Run a recovery tick and wait", "Nothing runs later; the link stays neutral");
      await expect("Recovery tick ran", recoveryTick);
      await expect.holds("The link stays neutral: no content, not processing, no attention, no Jev usage", 6_000, async () => {
        const l = await byId(api, N!.id);
        return !l.processing && l.content_state === "missing" && !l.attention_kind && !(await jevUsage(api, N!.id)).length;
      });
      await expect.visible(row(page, "held-yes.qa.example").getByText("No preview yet"), "Its row reads “No preview yet”");
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),

    scenario("X-02", "X-02: a login wall without the fallback — the waiting auto-tag fails for free, Use preview, then auto-tag", {
      ticket: "FAC-53 · FAC-56 · FAC-57",
      covers: "X-02 (FAC-53 AC2 + FAC-56 AC2 + FAC-57): the waiting auto-tag ends “Content missing” with no Usage row; the wall is in Needs attention; Use preview fixes it and a new auto-tag succeeds.",
      expected: "Auto-tag: “Content missing. Extract it first.”, no Jev usage. Needs attention: “Couldn't get the content: Got a login page instead of the content.”. Use preview takes it out, and Auto-tag then tags it.",
    }, async (ctx) => {
      const { page, step, click, type, expect, api, fixture } = ctx;
      await ensureTagAndLens(api);
      await page.reload();
      const url = fixture("wall-jam-slow", "x02");
      await step("Save a link that turns out to be a login wall (the page reader takes 10 s)", "It is extracting");
      await click(page.getByRole("button", { name: "Add link" }));
      await type(page.getByRole("textbox"), url);
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect.visible(toast(page, "Link saved"), "Toast: Link saved");
      const r = row(page, "wall-jam-slow.qa.example");

      await step("Right away, select it and click Auto-tag", "No dialog: its extraction is on the way, so the auto-tag waits for it");
      await pick(ctx, [r]);
      await barButton(ctx, "Auto-tag");
      await expect.hidden(page.getByRole("alertdialog"), "No “no content” dialog");
      const L = (await api.link(url))!;
      await openBatch(ctx, "Auto-tag");
      await expect.visible(activity(page).getByText("Waiting for extraction", { exact: true }), "Activity → Auto-tag: “Waiting for extraction”");

      await step("Wait for the extraction", "It hits the wall; the auto-tag ends “Content missing. Extract it first.” for free");
      await whileRunning(expect, "Polled every 0.4 s: the auto-tag never starts while the extraction runs",
        async () => (await jobsOf(api, L.id, "autotag"))[0]?.status === "failed", () => queueInvariant(api, [L.id]), 40_000);
      await expect(`API: auto-tag failed with “${MISSING}”; the link has content attention login_wall`, async () => {
        const l = await byId(api, L.id);
        return (await jobsOf(api, L.id, "autotag"))[0]?.error === MISSING && l.attention_kind === "content" && l.attention_reason === "login_wall";
      });
      await expect.visible(activity(page).getByText(MISSING, { exact: true }), `Activity → Auto-tag: “${MISSING}”`);
      await expect("Usage: no Jev row for the link", async () => (await jevUsage(api, L.id)).length === 0);
      await closeActivity(ctx);

      await step("Open Needs attention and click Use preview", "The wall's reason is listed; Use preview takes it out");
      await click(attentionNav(page));
      const ar = row(page, "QA slow wall x-02/x02");
      await expect.visible(ar.getByText(WALL, { exact: true }), `Row: “${WALL}”`);
      await expect.hidden(page.locator("main").getByText(MISSING), "The auto-tag failure is not listed");
      await click(ar.getByRole("button", { name: "Use preview", exact: true }));
      await expect("API: content from the preview (Partial), no attention", async () => {
        const l = await byId(api, L.id);
        return l.content_source === "preview" && l.content_state === "partial" && !l.attention_kind;
      }, { timeout: 8_000 });
      await expect.hidden(attentionNav(page), "Needs attention is empty", { timeout: 8_000 });

      await step("Back in All links, select it and click Auto-tag again", "This time Jev reads the preview text and the link is tagged");
      await click(allLinksNav(page));
      await pick(ctx, [row(page, "QA slow wall x-02/x02")]);
      await barButton(ctx, "Auto-tag");
      await expect("API: the new auto-tag is done and evaluated the link", async () => {
        const jobs = await jobsOf(api, L.id, "autotag");
        return jobs.length === 2 && jobs.at(-1)?.status === "done" && !!(await evaluated(api, L.id));
      }, { timeout: 15_000 });
      await expect("Usage: exactly one Jev row for the link (the second auto-tag)", async () => (await jevUsage(api, L.id)).length === 1);
    }),

    scenario("X-01", "X-01: a login wall with the fallback on — the waiting auto-tag runs on the preview text", {
      ticket: "FAC-53 · FAC-56 · FAC-57",
      covers: "X-01: a new wall link is auto-tagged at once; the auto-tag waits for the extraction, which falls back to the preview, and then runs on that text.",
      expected: "The auto-tag reads “Waiting for extraction”, then runs on the title and description (Partial content) and is done. One Jev Usage row; the link never enters Needs attention.",
    }, async (ctx) => {
      const { page, step, click, type, expect, api, fixture } = ctx;
      await ensureTagAndLens(api);
      await page.reload();
      await step("Turn on “use the preview for Jev” in Settings", "The setting is on");
      await setFallback(ctx, true);

      const url = fixture("wall-jam-slow", "x01");
      await step("Save a new login-wall link and, right away, select it and click Auto-tag", "The auto-tag waits for the extraction");
      await click(page.getByRole("button", { name: "Add link" }));
      await type(page.getByRole("textbox"), url);
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect.visible(toast(page, "Link saved"), "Toast: Link saved");
      await pick(ctx, [row(page, "wall-jam-slow.qa.example")]);
      await barButton(ctx, "Auto-tag");
      const L = (await api.link(url))!;
      await openBatch(ctx, "Auto-tag");
      await expect.visible(activity(page).getByText("Waiting for extraction", { exact: true }), "Activity → Auto-tag: “Waiting for extraction”");

      await step("Wait", "The wall is discarded, the preview becomes the content, and the auto-tag runs on it");
      await whileRunning(expect, "Polled every 0.4 s: never in Needs attention, no auto-tag before the extraction ends",
        async () => (await jobsOf(api, L.id, "autotag"))[0]?.status === "done",
        async () => {
          const l = await byId(api, L.id);
          if (l.attention_kind) return `flagged: ${l.attention_kind}`;
          if (await attentionNav(page).isVisible()) return "Needs attention appeared";
          return queueInvariant(api, [L.id]);
        }, 40_000);
      await expect("API: content from the preview (Partial, reason login_wall), no attention", async () => {
        const l = await byId(api, L.id);
        return l.content_source === "preview" && l.content_state === "partial" && l.content_reason === "login_wall" && !l.attention_kind;
      });
      await expect("API: Jev evaluated the link; its content is the title and description", async () => {
        const l = await byId(api, L.id);
        return !!(await evaluated(api, L.id)) && (await content(api, L.id)) === `${l.title}\n\n${l.description}`;
      });
      await expect("Usage: exactly one Jev row for the link", async () => (await jevUsage(api, L.id)).length === 1);
      await expect.hidden(activity(page).getByText("Waiting for extraction"), "Activity: nothing waits any more");
      await closeActivity(ctx);
      await expect.hidden(attentionNav(page), "Nothing in Needs attention");
    }),
  ],
});
