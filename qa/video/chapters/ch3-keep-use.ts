// Chapter 3 "Keep what you had, use what you have" (FAC-56 + FAC-57 + previous content): planning/qa/fac-48-test-plan.md §12.
// Profile FIX (fixture Jev, default 2-slot pool). The runner puts the preview fallback back to off before each
// scenario, so every scenario turns it on in Settings when it needs it, on screen.
import { resolve } from "node:path";
import type { Locator, Page } from "playwright-core";
import { chapter, scenario, type Api, type Expect, type ScenarioContext } from "../recorder";
import { OUT } from "../env";

type Ctx = Pick<ScenarioContext, "page" | "click" | "paste" | "expect" | "api" | "step">;

const attentionNav = (page: Page) => page.locator("aside").getByRole("button", { name: /Needs attention/ });
const allLinksNav = (page: Page) => page.locator("aside").getByRole("button", { name: /^All links/ });
const settingsNav = (page: Page) => page.locator("aside").getByRole("button", { name: "Settings", exact: true });
const activityNav = (page: Page) =>
  page.locator("aside").getByRole("button", { name: /^(Activity|Extracting|Fetching preview|Auto-tagging|Applying lens)/ });
const activity = (page: Page) => page.getByRole("dialog", { name: "Activity" });
const jobRows = (page: Page): Locator => activity(page).locator("div.rounded-md");
/** The library row of the link on this fixture host (one link per host in every scenario). */
const row = (page: Page, host: string) => page.locator("main article").filter({ hasText: `${host}.qa.example` });
const badge = (r: Locator, text: string) => r.getByText(text, { exact: true });
const fallbackBox = (page: Page) => page.getByRole("status").filter({ hasText: "Content extracted from preview" });
const partialHeader = (page: Page) => page.locator("p").filter({ hasText: /· Content extracted from preview · Partial$/ });

const SETTING = "If the content can't be extracted, use the preview for Jev";
const EMPTY_MSG = "The page returned no content. You can paste it manually.";
const WALL_MSG = "Got a login page instead of the content.";
const EMPTY = `Couldn't get the content: ${EMPTY_MSG}`;
const WALL = `Couldn't get the content: ${WALL_MSG}`;
const DNS_CONTENT = "Couldn't get the content: The site could not be reached.";
const USE_PREVIEW_TIP = "Save the title and description as the content, so Jev can use it";
const previous = (msg: string) => `Last extraction failed, showing the previous version: ${msg}`;
const boxText = (msg: string) => `Only the title and description are saved, because the page content couldn't be extracted: ${msg}`;

/** Opens Add link, pastes `text` and saves. */
async function addLinks({ page, click, paste }: Pick<Ctx, "page" | "click" | "paste">, text: string) {
  await click(page.getByRole("button", { name: "Add link" }));
  await paste(page.getByRole("textbox"), text);
  await click(page.getByRole("button", { name: /^Save/ }));
}

/** Settings → sets the preview fallback checkbox to `on` (clicking only when needed), checks UI and API, closes. */
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

/** The sidebar's Needs attention count, or 0 when the entry is gone. */
async function counter(page: Page) {
  const nav = attentionNav(page);
  if (!(await nav.isVisible())) return 0;
  return Number((await nav.innerText()).match(/(\d+)\s*$/)?.[1] ?? NaN);
}

/** JSON log lines of `event` the Worker printed for this job (the log can hold older runs; the job id is unique). */
async function logEvents(event: string, jobId: string): Promise<{ e: any; raw: string }[]> {
  const text = await Bun.file(resolve(OUT, "logs/dev.log")).text();
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf(`{"event":"${event}"`);
    if (at < 0) return [];
    try {
      const e = JSON.parse(line.slice(at));
      return e.job_id === jobId ? [{ e, raw: line.slice(at) }] : [];
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

const latestJob = async (api: Api, url: string) => (await api.jobs(url))[0];
const settled = async (api: Api, url: string) => {
  const l = await api.link(url);
  return !!l && !l.processing;
};
const content = async (api: Api, id: string) => (await api.get<{ markdown: string }>(`/links/${id}/content`)).markdown;
/** Never flagged while running: no attention in the API, no Needs attention entry, no "Context failed" badge. */
const notFlagged = (page: Page, api: Api, url: string, r: Locator) => async () => {
  const l = await api.link(url);
  if (!l?.processing) return null;
  if (l.attention_kind) return `flagged while running: ${l.attention_kind}`;
  if (await attentionNav(page).isVisible()) return "Needs attention appeared while it ran";
  return (await badge(r, "Context failed").isVisible()) ? "“Context failed” appeared while it ran" : null;
};

/** Opens the link in the Inspector (click on its title line) and shows the Content tab. */
async function inspect({ page, click }: Pick<Ctx, "page" | "click">, r: Locator) {
  await click(r.locator("p").first());
  await click(page.getByRole("tab", { name: "Content" }));
}

/** Opens Activity → the newest Extract context batch. */
async function openExtractBatch({ page, click }: Pick<Ctx, "page" | "click">) {
  await click(activityNav(page));
  await click(activity(page).getByText("Extract context", { exact: true }).first());
}

/** Row menu (already open) → Re-extract context → confirms “Extract context for 1 link?”, which warns that the content is replaced. */
async function reextract({ page, click, expect }: Pick<Ctx, "page" | "click" | "expect">) {
  await click(page.getByRole("menuitem", { name: "Re-extract context" }));
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "Extract context for 1 link?" });
  await expect.visible(confirm.getByText("1 of 1 already have context", { exact: false }), "Confirm: “1 of 1 already have context — extracting again replaces it…”");
  await click(confirm.getByRole("button", { name: "Extract", exact: true }));
}

const refusal = async (api: Api, path: string) => {
  try {
    await api.send("POST", path, {});
    return "accepted";
  } catch (e) {
    return String((e as Error).message).replace(/^POST \S+ → /, "");
  }
};

export default chapter({
  id: "ch3-keep-use",
  title: "Keep what you had, use what you have",
  ticket: "FAC-56 · FAC-57 · FAC-48",
  summary: [
    "Settings: “use the preview for Jev” is off by default and persists",
    "With it on, an empty page saves its title and description as Partial content, can be auto-tagged, and survives a failed “Retry getting content”",
    "No preview, no fallback; with the setting off, “Use preview” does it on demand",
    "A failed re-extract keeps the content you had and stays out of Needs attention",
    "Login walls and challenge pages are discarded with a plain reason; a long article with “Sign in” is kept",
  ],
  scenarios: [
    scenario("PF-01", "PF-01: the preview fallback setting is off by default and persists", {
      ticket: "FAC-56",
      covers: "PF-01: the Settings dialog (sidebar, under Activity) holds one library-wide setting, off by default, saved on click.",
      expected: "“Settings”, “Applies to the whole library.” and “If the content can't be extracted, use the preview for Jev”, unchecked. Checked, it stays checked after a reload, and the API returns preview_fallback: true.",
    }, async ({ page, step, click, expect, api }) => {
      await step("Open Settings from the sidebar", "One setting, unchecked by default");
      await click(settingsNav(page));
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect.visible(dialog.getByRole("heading", { name: "Settings" }), "Dialog title “Settings”");
      await expect.visible(dialog.getByText("Applies to the whole library.", { exact: true }), "“Applies to the whole library.”");
      const box = dialog.getByRole("checkbox", { name: SETTING });
      await expect.visible(box, `Checkbox “${SETTING}”`);
      await expect("Off by default (checkbox and API)", async () => !(await box.isChecked()) && (await api.library()).settings?.preview_fallback === false);

      await step("Check it", "Saved right away");
      await click(box);
      await expect("API: settings.preview_fallback is true", async () => (await api.library()).settings?.preview_fallback === true, { timeout: 5_000 });
      await expect("The checkbox is checked", async () => box.isChecked());
      await page.keyboard.press("Escape");

      await step("Reload and open Settings again", "Still checked");
      await page.reload();
      await click(settingsNav(page));
      await expect("After the reload: still checked", async () => page.getByRole("checkbox", { name: SETTING }).isChecked(), { timeout: 8_000 });
      await expect("After the reload: the API still returns preview_fallback: true", async () => (await api.library()).settings?.preview_fallback === true);
      await page.keyboard.press("Escape");
    }),

    scenario("PF-02", "PF-02 + PF-03 + PF-04: with the setting on, an empty page uses its preview, is auto-tagged, and keeps it after a failed retry", {
      ticket: "FAC-56 (AC1, AC3)",
      covers: "PF-02: a final content failure with the setting on saves the preview as Partial content and never enters Needs attention. PF-03: that link can be auto-tagged and Jev reads only the title and description. PF-04: a failed “Retry getting content” keeps the fallback.",
      expected: "Never in Needs attention and no “Context failed”. Inspector: “Content extracted from preview · Partial” and the box with the reason and “Retry getting content”; Activity: “Used the preview as content instead.”. Auto-tag gives a score. The retry shows “Updating extraction… showing saved content”, fails, and the preview content stays.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("empty-slow", "page");
      await step("Turn on “use the preview for Jev” in Settings", "The setting is on");
      await setFallback({ page, click, expect, api }, true);

      await step("Add a link whose preview works but whose page is empty", "Not flagged while it runs, nor after: the preview becomes the content");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      const r = row(page, "empty-slow");
      await whileRunning(expect, "Never in Needs attention while it runs (API, sidebar and badge, every 0.4 s)",
        () => settled(api, url), notFlagged(page, api, url, r), 40_000);
      await expect("API: content from preview, Partial, no attention, content_reason empty", async () => {
        const l = await api.link(url);
        return l && l.content_source === "preview" && l.content_state === "partial" && l.attention_kind === null && l.content_reason === "empty" && l.status === "ready";
      }, { timeout: 5_000 });
      const link = (await api.link(url))!;
      await expect.holds("Afterwards: no Needs attention entry and no “Context failed” badge", 3_000, async () =>
        !(await attentionNav(page).isVisible()) && !(await badge(r, "Context failed").isVisible()));

      await step("Open it in the Inspector", "“Content extracted from preview · Partial” and a box with the reason and “Retry getting content”");
      await inspect({ page, click }, r);
      await expect.visible(partialHeader(page), "Header: “… · Content extracted from preview · Partial”");
      await expect.visible(fallbackBox(page).getByText(boxText(EMPTY_MSG), { exact: true }), "Box: “Only the title and description are saved, because … The page returned no content. You can paste it manually.”");
      await expect.visible(fallbackBox(page).getByRole("button", { name: "Retry getting content" }), "Box: “Retry getting content”");
      await expect("API: the stored content is the title and description", async () => (await content(api, link.id)) === `${link.title}\n\n${link.description}`);

      await step("Open Activity → Extract context", "The job failed with its reason, and “Used the preview as content instead.”");
      await openExtractBatch({ page, click });
      await expect.visible(activity(page).getByText(EMPTY_MSG, { exact: true }), `Activity: the job's reason “${EMPTY_MSG}”`);
      await expect.visible(activity(page).getByText("Used the preview as content instead.", { exact: true }), "Activity: “Used the preview as content instead.”");
      await expect("API: the job is failed with reason empty and step “Used the preview”", async () => {
        const j = await latestJob(api, url);
        return j.status === "failed" && j.reason === "empty" && j.step === "Used the preview";
      });
      await page.keyboard.press("Escape");

      await step("PF-03: create the tag “QA topic” (API) and reload; Inspector → Analysis → Re-evaluate (auto-tag)", "It gets a score; Jev read only the title and description");
      await api.send("POST", "/tags", { name: "QA topic" });
      await expect("API: the tag “qa topic” exists (names are stored lowercase)", async () => (await api.library()).tags?.some((t: any) => t.name === "qa topic"));
      await page.reload();
      await expect.visible(page.locator("aside").getByText("qa topic", { exact: true }), "Sidebar lists the tag “qa topic”");
      await inspect({ page, click }, r);
      await click(page.getByRole("tab", { name: "Analysis" }));
      await click(page.getByRole("button", { name: "Re-evaluate" }));
      await expect("API: the link has a “qa topic” score", async () => {
        const l = await api.link(url);
        const tag = (await api.library()).tags.find((t: any) => t.name === "qa topic");
        return l?.evaluations?.some((e: any) => e.tag_id === tag?.id && typeof e.probability === "number");
      }, { timeout: 30_000 });
      await expect.visible(page.getByRole("tabpanel").getByText(/^\d+%$/).first(), "Analysis shows the score");
      await expect.visible(page.getByRole("tabpanel").getByRole("button", { name: "qa topic" }), "Analysis lists “qa topic”");
      await expect("API: the auto-tag job is done", async () => {
        const jobs = await api.jobs(url);
        return jobs.some((j) => j.kind === "autotag" && j.status === "done");
      }, { timeout: 10_000 });
      await expect("GET /content: only the title and description, no “from preview” label", async () => {
        const md = await content(api, link.id);
        return md === `${link.title}\n\n${link.description}` && !/from preview/i.test(md);
      });

      await step("PF-04: Content tab → “Retry getting content” (the page is still empty)", "“Updating extraction… showing saved content”, the button disabled; then the preview content stays");
      await click(page.getByRole("tab", { name: "Content" }));
      await click(fallbackBox(page).getByRole("button", { name: "Retry getting content" }));
      await expect.visible(page.getByText("Updating extraction… showing saved content", { exact: true }), "While it runs: “Updating extraction… showing saved content”");
      await expect("While it runs: “Retry getting content” is disabled", async () =>
        fallbackBox(page).getByRole("button", { name: "Retry getting content" }).isDisabled(), { timeout: 5_000 });
      await whileRunning(expect, "Never in Needs attention while the retry runs",
        () => settled(api, url), notFlagged(page, api, url, r), 40_000);
      await expect("API: the retry failed (empty); the preview content stays, Partial, no attention", async () => {
        const [l, j] = [await api.link(url), await latestJob(api, url)];
        return l && j.kind === "extract" && j.status === "failed" && j.reason === "empty"
          && l.content_source === "preview" && l.content_state === "partial" && l.attention_kind === null && l.content_key === link.content_key;
      }, { timeout: 8_000 });
      await expect.visible(fallbackBox(page).getByText(boxText(EMPTY_MSG), { exact: true }), "The box stays, with the same reason");
      await expect.visible(partialHeader(page), "Header still “Content extracted from preview · Partial”");
      await expect.hidden(attentionNav(page), "No Needs attention entry");
    }),

    scenario("PF-07", "PF-07: when the preview failed too there is nothing to use, so the link still needs attention", {
      ticket: "FAC-56",
      covers: "PF-07: with the setting on, an unreachable host fails preview and content; the fallback does not apply and Use preview is not offered.",
      expected: "“Couldn't get the content: The site could not be reached.” in Needs attention, no Use preview button or menu item; POST /use-preview answers “There is no preview to use.”.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("nowhere", "page");
      await step("Turn the setting on, then add a link whose host does not resolve", "Preview and content both fail");
      await setFallback({ page, click, expect, api }, true);
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await expect("API: content attention “unreachable”, preview failed, no content", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.attention_kind === "content" && l.attention_reason === "unreachable" && l.status === "failed" && !l.content_key && l.content_source !== "preview";
      }, { timeout: 60_000 });

      await step("Look at the row and its menu", "In Needs attention as usual, with no Use preview");
      const r = row(page, "nowhere");
      await expect.visible(r.getByText(DNS_CONTENT, { exact: true }), `Row: “${DNS_CONTENT}”`);
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1, { timeout: 5_000 });
      await expect.hidden(r.getByRole("button", { name: "Use preview", exact: true }), "No Use preview button");
      await click(r.getByRole("button", { name: "Link actions" }));
      await expect.visible(page.getByRole("menuitem", { name: "Copy URL" }), "The row menu is open");
      await expect.hidden(page.getByRole("menuitem", { name: "Use preview as content" }), "No “Use preview as content” in the menu");
      await page.keyboard.press("Escape");

      await step("Ask the API to use the preview anyway", "“There is no preview to use.”");
      const reply = await refusal(api, `/links/${(await api.link(url))!.id}/use-preview`);
      await expect(`API POST /use-preview → ${reply}`, () => reply.startsWith("400") && reply.includes("There is no preview to use."));
      await expect("API: still in Needs attention for the content", async () => (await api.link(url))?.attention_kind === "content");
    }),

    scenario("PF-06", "PF-06: with the setting off, “Use preview” does the same on demand", {
      ticket: "FAC-56 (AC2)",
      covers: "PF-06: with the setting off, an empty page enters Needs attention with Retry, Use preview and Dismiss (and “Use preview as content” in its menu); Use preview saves the preview as content and takes it out of the list.",
      expected: "“Couldn't get the content: The page returned no content. You can paste it manually.” with Retry, Use preview (tooltip “Save the title and description as the content, so Jev can use it”) and Dismiss. Use preview: the row leaves the list, the counter goes 2 → 1, and the Inspector shows the preview box.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const empty = fixture("empty-page", "page"), gone = fixture("gone", "page");
      await step("Check Settings: the fallback is off", "Unchecked");
      await setFallback({ page, click, expect, api }, false);

      await step("Add an empty page and a missing page", "Both enter Needs attention (2)");
      await addLinks({ page, click, paste }, `${empty}\n${gone}`);
      await expect.visible(page.getByText("2 links saved", { exact: true }), "Toast: 2 links saved");
      await expect("API: the empty page has content attention “empty” and no content", async () => {
        const [e, g] = [await api.link(empty), await api.link(gone)];
        return e && g && !e.processing && !g.processing && e.attention_kind === "content" && e.attention_reason === "empty" && !e.content_key && g.attention_kind;
      }, { timeout: 30_000 });
      await expect("Sidebar: Needs attention (2)", async () => (await counter(page)) === 2, { timeout: 5_000 });

      await step("Filter by Needs attention and look at the empty page", "Its reason with Retry, Use preview and Dismiss; the menu offers “Use preview as content”");
      await click(attentionNav(page));
      const r = row(page, "empty-page");
      await expect.visible(r.getByText(EMPTY, { exact: true }), `Row: “${EMPTY}”`);
      const use = r.getByRole("button", { name: "Use preview", exact: true });
      await expect.visible(r.getByRole("button", { name: "Retry", exact: true }), "Retry is offered");
      await expect.visible(use, "Use preview is offered");
      await expect.visible(r.getByRole("button", { name: "Dismiss", exact: true }), "Dismiss is offered");
      await expect(`Use preview tooltip: “${USE_PREVIEW_TIP}”`, async () => (await use.getAttribute("title")) === USE_PREVIEW_TIP);
      await click(r.getByRole("button", { name: "Link actions" }));
      await expect.visible(page.getByRole("menuitem", { name: "Use preview as content" }), "Menu: “Use preview as content”");
      await page.keyboard.press("Escape");

      await step("Click Use preview", "It leaves the list and the counter goes 2 → 1");
      await click(use);
      await expect.hidden(r, "The row left the Needs attention list");
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1, { timeout: 5_000 });
      await expect("API: content from preview, Partial, no attention", async () => {
        const l = await api.link(empty);
        return l && l.content_source === "preview" && l.content_state === "partial" && l.attention_kind === null;
      });
      const l = (await api.link(empty))!;
      await expect("API: the stored content is the title and description", async () => (await content(api, l.id)) === `${l.title}\n\n${l.description}`);

      await step("Open it from All links in the Inspector", "The preview box and “Partial”");
      await click(allLinksNav(page));
      await inspect({ page, click }, row(page, "empty-page"));
      await expect.visible(partialHeader(page), "Header: “… · Content extracted from preview · Partial”");
      await expect.visible(fallbackBox(page).getByText(boxText(EMPTY_MSG), { exact: true }), "Box: “Content extracted from preview” with the reason");
    }),

    scenario("NA-27", "NA-27 + PF-09: a failed re-extract keeps the pasted content and stays out of Needs attention", {
      ticket: "FAC-48 · FAC-56",
      covers: "NA-27: re-extracting a link that has content, when the extraction fails, keeps that content and never flags it. PF-09: with the preview fallback on, the previous content still wins over the preview.",
      expected: "During the job: “Updating extraction… showing saved content”. Afterwards: “Last extraction failed, showing the previous version: The page returned no content. You can paste it manually.” above the pasted text; not in Needs attention; content key and version unchanged; Activity lists the failed job.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("empty-slow", "page");
      const PASTED = "QA previous version";
      await step("Turn the setting on (PF-09)", "The setting is on");
      await setFallback({ page, click, expect, api }, true);

      await step("Add an empty page and cancel its job in Activity before the page is read", "The link is left with no content and no failure");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await openExtractBatch({ page, click });
      await click(jobRows(page).first().getByRole("button", { name: "Cancel", exact: true }));
      await expect.visible(jobRows(page).filter({ hasText: "Cancelled" }).first(), "Activity: the job is Cancelled");
      await expect("API: no content, not failed, no attention", async () => {
        const l = await api.link(url);
        return l && !l.processing && !l.content_key && l.content_state === "missing" && l.attention_kind === null;
      }, { timeout: 10_000 });
      await page.keyboard.press("Escape");

      await step(`Inspector → Paste text “${PASTED}” → Save`, "The link has manual content");
      const r = row(page, "empty-slow");
      await inspect({ page, click }, r);
      await click(page.getByRole("button", { name: "Paste text", exact: true }));
      await paste(page.locator("textarea"), PASTED);
      await click(page.getByRole("button", { name: "Save", exact: true }));
      await expect("API: content ready, manual", async () => {
        const l = await api.link(url);
        return l && l.content_state === "ready" && l.content_source === "manual" && l.content_key;
      }, { timeout: 8_000 });
      const before = (await api.link(url))!;

      await step("Row menu → Re-extract context (the page is still empty)", "“Updating extraction… showing saved content” while it runs");
      await click(r.getByRole("button", { name: "Link actions" }));
      await reextract({ page, click, expect });
      await expect.visible(page.getByText("Updating extraction… showing saved content", { exact: true }), "Inspector: “Updating extraction… showing saved content”");
      await whileRunning(expect, "Never in Needs attention while it runs", () => settled(api, url), notFlagged(page, api, url, r), 40_000);

      await step("The extraction failed", "The pasted text stays, with a note; the link is not in Needs attention");
      await expect("API: the job failed (empty); no attention; content key, version and source unchanged (not the preview)", async () => {
        const [l, j] = [await api.link(url), await latestJob(api, url)];
        return l && j.status === "failed" && j.reason === "empty" && l.attention_kind === null
          && l.content_key === before.content_key && l.content_version === before.content_version && l.content_source === "manual";
      }, { timeout: 8_000 });
      await expect("GET /content: still the pasted text", async () => (await content(api, before.id)) === PASTED);
      await expect.visible(page.getByRole("alert").filter({ hasText: previous(EMPTY_MSG) }), `Inspector: “${previous(EMPTY_MSG)}”`);
      await expect.visible(page.getByText(PASTED, { exact: true }), `Inspector shows “${PASTED}”`);
      await expect.hidden(fallbackBox(page), "No preview box (the preview did not replace it)");
      await expect.hidden(attentionNav(page), "No Needs attention entry");
      await openExtractBatch({ page, click });
      await expect.visible(activity(page).getByText(EMPTY_MSG, { exact: true }), `Activity: the failed job with “${EMPTY_MSG}”`);
      await page.keyboard.press("Escape");
    }),

    scenario("LW-01", "LW-01 (+ LW-02): a challenge page and a login form are discarded with a plain reason", {
      ticket: "FAC-57 (AC1, AC2)",
      covers: "LW-01: a Cloudflare “Just a moment...” page is not content: it is discarded after one attempt and the link enters Needs attention. LW-02 (log only in the plan): a sign-in form, the same way.",
      expected: "Both rows keep their title and read “Couldn't get the content: Got a login page instead of the content.” with Retry, Use preview and Dismiss. One attempt each, nothing stored; the log has login_wall_detected (domain, pattern, length, no URL) and a final, non-retryable login_wall failure.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const jam = fixture("wall-jam", "story"), signin = fixture("login-wall", "story");
      await step("Add an article behind a “Just a moment...” challenge and one behind a sign-in form", "Both fail at once with a plain reason");
      await addLinks({ page, click, paste }, `${jam}\n${signin}`);
      await expect.visible(page.getByText("2 links saved", { exact: true }), "Toast: 2 links saved");
      await expect("API: both have content attention “login_wall”, with no content stored", async () => {
        const ls = [await api.link(jam), await api.link(signin)];
        return ls.every((l) => l && !l.processing && l.attention_kind === "content" && l.attention_reason === "login_wall" && !l.content_key && l.status === "ready");
      }, { timeout: 30_000 });
      await expect("Sidebar: Needs attention (2)", async () => (await counter(page)) === 2, { timeout: 5_000 });

      await step("Look at the rows", "The title is kept; the reason, Retry, Use preview and Dismiss");
      for (const [host, title] of [["wall-jam", "QA wall"], ["login-wall", "Members article"]] as const) {
        const r = row(page, host);
        await expect.visible(r.getByText(new RegExp(`^${title} `)).first(), `${host}: title “${title} …” kept`);
        await expect.visible(r.getByText(WALL, { exact: true }), `${host}: “${WALL}”`);
        for (const name of ["Retry", "Use preview", "Dismiss"])
          await expect.visible(r.getByRole("button", { name, exact: true }), `${host}: ${name}`);
      }

      await step("Open Activity and check the Worker log", "Each job failed after one attempt; the wall was detected and logged without the URL");
      await openExtractBatch({ page, click });
      await expect("Activity: two failed jobs reading “Got a login page instead of the content.”", async () =>
        (await activity(page).getByText(WALL_MSG, { exact: true }).count()) === 2, { timeout: 5_000 });
      for (const [url, pattern] of [[jam, "just a moment"], [signin, "log in to continue"]] as const) {
        const host = new URL(url).hostname, job = await latestJob(api, url);
        await expect(`API: ${host} job failed with login_wall after attempt 1`, async () => job.status === "failed" && job.reason === "login_wall" && job.attempt === 1);
        await expect(`Log: login_wall_detected for ${host}, pattern “${pattern}”, with text length`, async () => {
          const ev = await logEvents("login_wall_detected", job.id);
          const ok = ev.length === 1 && ev[0]!.e.domain === host && ev[0]!.e.pattern === pattern && typeof ev[0]!.e.text_length === "number";
          if (!ok) throw new Error(`log has ${JSON.stringify(ev.map((x) => x.e))}`);
          return true;
        }, { timeout: 5_000 });
        await expect(`Log: one content failure for ${host}: login_wall, final, not retryable`, async () => {
          const ev = (await logEvents("link_step_failed", job.id)).filter((x) => x.e.step === "content");
          const ok = ev.length === 1 && ev[0]!.e.reason === "login_wall" && ev[0]!.e.final === true && ev[0]!.e.retryable === false && ev[0]!.e.attempt === 1;
          if (!ok) throw new Error(`log has ${JSON.stringify(ev.map((x) => x.e))}`);
          return true;
        }, { timeout: 5_000 });
        await expect(`Log: no line of the ${host} job carries the URL`, async () => {
          const lines = [...(await logEvents("login_wall_detected", job.id)), ...(await logEvents("link_step_failed", job.id))].map((x) => x.raw);
          const leak = lines.find((raw) => raw.includes(url) || raw.includes("/story"));
          if (leak) throw new Error(`leaks the URL: ${leak.slice(0, 200)}`);
          return lines.length >= 2;
        });
      }
      await page.keyboard.press("Escape");
    }),

    scenario("LW-04", "LW-04: a login wall on a link that already has content keeps that content", {
      ticket: "FAC-57 (AC2)",
      covers: "LW-04: when a re-extract hits a wall, the previous (pasted) content is kept, the failure is noted, and the link stays out of Needs attention.",
      expected: "The Inspector keeps “QA good content” with “Last extraction failed, showing the previous version: Got a login page instead of the content.”; not in Needs attention; Activity shows the failed job; content_version unchanged.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("wall-jam", "story");
      const PASTED = "QA good content";
      await step("Add an article behind a challenge page", "It fails with the login-page reason");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await expect("API: content attention login_wall", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.attention_kind === "content" && l.attention_reason === "login_wall";
      }, { timeout: 30_000 });
      const r = row(page, "wall-jam");
      await expect.visible(r.getByText(WALL, { exact: true }), `Row: “${WALL}”`);

      await step(`Inspector → Paste text “${PASTED}” → Save`, "The link has content and leaves Needs attention");
      await inspect({ page, click }, r);
      await click(page.getByRole("button", { name: "Paste text", exact: true }));
      await paste(page.locator("textarea"), PASTED);
      await click(page.getByRole("button", { name: "Save", exact: true }));
      await expect("API: content ready (manual), no attention", async () => {
        const l = await api.link(url);
        return l && l.content_state === "ready" && l.content_source === "manual" && l.attention_kind === null;
      }, { timeout: 8_000 });
      await expect.hidden(attentionNav(page), "Sidebar: no Needs attention entry");
      const before = (await api.link(url))!;

      await step("Row menu → Re-extract context (the challenge is still there)", "The wall is discarded; the pasted content stays");
      const jobsBefore = (await api.jobs(url)).length;
      await click(r.getByRole("button", { name: "Link actions" }));
      await reextract({ page, click, expect });
      await expect("API: a new extract job ran and failed with login_wall", async () => {
        const jobs = await api.jobs(url);
        return jobs.length > jobsBefore && jobs[0].kind === "extract" && jobs[0].status === "failed" && jobs[0].reason === "login_wall" && (await settled(api, url));
      }, { timeout: 30_000 });
      await expect("API: no attention; content key and version unchanged", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === null && l.content_key === before.content_key && l.content_version === before.content_version && l.content_source === "manual";
      });
      await expect("GET /content: still the pasted text", async () => (await content(api, before.id)) === PASTED);
      await expect.visible(page.getByRole("alert").filter({ hasText: previous(WALL_MSG) }), `Inspector: “${previous(WALL_MSG)}”`);
      await expect.visible(page.getByText(PASTED, { exact: true }), `Inspector shows “${PASTED}”`);
      await expect.hidden(attentionNav(page), "Still no Needs attention entry");
      await openExtractBatch({ page, click });
      await expect.visible(activity(page).getByText(WALL_MSG, { exact: true }), `Activity: the failed job with “${WALL_MSG}”`);
      await page.keyboard.press("Escape");
    }),

    scenario("LW-05", "LW-05: a login wall with the setting on falls back to the preview", {
      ticket: "FAC-57 (AC2) · FAC-56 (AC1)",
      covers: "LW-05: with the preview fallback on, a wall on a new link saves the preview as Partial content; the wall text is never stored.",
      expected: "“Content extracted from preview · Partial”, not in Needs attention. Activity: “Got a login page instead of the content.” and “Used the preview as content instead.”. The stored text is the title and description, with none of the wall text.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("wall-jam", "members-only");
      await step("Turn the setting on", "The setting is on");
      await setFallback({ page, click, expect, api }, true);

      await step("Add a new article behind a challenge page", "Never in Needs attention; the preview becomes the content");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      const r = row(page, "wall-jam");
      await whileRunning(expect, "Never in Needs attention while it runs", () => settled(api, url), notFlagged(page, api, url, r), 30_000);
      await expect("API: content from preview, Partial, no attention, content_reason login_wall", async () => {
        const l = await api.link(url);
        return l && l.content_source === "preview" && l.content_state === "partial" && l.attention_kind === null && l.content_reason === "login_wall";
      }, { timeout: 5_000 });
      const l = (await api.link(url))!;
      await expect("GET /content: only the title and description, none of the wall text", async () => {
        const md = await content(api, l.id);
        return md === `${l.title}\n\n${l.description}` && !/just a moment|checking your browser/i.test(md);
      });
      await expect.hidden(attentionNav(page), "No Needs attention entry");

      await step("Open Activity → Extract context", "The wall reason and “Used the preview as content instead.”");
      await openExtractBatch({ page, click });
      await expect.visible(activity(page).getByText(WALL_MSG, { exact: true }), `Activity: “${WALL_MSG}”`);
      await expect.visible(activity(page).getByText("Used the preview as content instead.", { exact: true }), "Activity: “Used the preview as content instead.”");
      await page.keyboard.press("Escape");

      await step("Open it in the Inspector", "“Content extracted from preview · Partial” with the wall reason");
      await inspect({ page, click }, r);
      await expect.visible(partialHeader(page), "Header: “… · Content extracted from preview · Partial”");
      await expect.visible(fallbackBox(page).getByText(boxText(WALL_MSG), { exact: true }), "Box: “… couldn't be extracted: Got a login page instead of the content.”");
    }),

    scenario("LW-06", "LW-06: a long article with a “Sign in” link in its header is kept", {
      ticket: "FAC-57 (AC1, negative)",
      covers: "LW-06: wall detection only looks at short pages; a long article whose header links to “Sign in” is real content.",
      expected: "The content is ready (from the page), the link is not in Needs attention, and no login_wall_detected event is logged.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("long-signin", "article");
      await step("Add a long article whose header has a “Sign in” link", "Saved as content");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await expect("API: content ready from the page, no attention", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.content_state === "ready" && l.content_source === "web" && l.attention_kind === null;
      }, { timeout: 30_000 });
      const l = (await api.link(url))!;
      await expect("GET /content: the article, with its “[Sign in](/login)” line, over 1,500 characters", async () => {
        const md = await content(api, l.id);
        return md.includes("[Sign in](/login)") && md.length > 1500;
      });
      const job = await latestJob(api, url);
      await expect("Log: no login_wall_detected and no failure for this job", async () =>
        (await logEvents("login_wall_detected", job.id)).length === 0 && (await logEvents("link_step_failed", job.id)).length === 0 && job.status === "done");

      await step("Open it in the Inspector", "The article is shown, with no failure note");
      const r = row(page, "long-signin");
      await expect.hidden(badge(r, "Context failed"), "No “Context failed” badge");
      await inspect({ page, click }, r);
      await expect.visible(page.getByText(/^Paragraph 1\. This deterministic QA article/).first(), "Inspector shows the article text");
      await expect.hidden(page.getByText(/^Last extraction failed/), "No “Last extraction failed” note");
      await expect.hidden(attentionNav(page), "No Needs attention entry");
    }),
  ],
});
