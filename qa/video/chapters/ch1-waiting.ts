// Chapter 1 "Waiting is not failing" (FAC-48 core, part 1): planning/qa/fac-48-test-plan.md §12.
// Profile FIX-SLOT1: one browser slot, so a slow page holds the queue and the links behind it wait > 30 s.
// Supersedes the pilot's P1 (repro A): NA-01 is the same story with the plan's fixtures.
import type { Locator, Page } from "playwright-core";
import { chapter, scenario, type Api, type ScenarioContext } from "../recorder";

const attentionNav = (page: Page) => page.locator("aside").getByRole("button", { name: /Needs attention/ });
// The sidebar's Activity entry reads "Extracting 2/6" (or "Fetching preview 0/1") while a batch runs.
const activityNav = (page: Page) =>
  page.locator("aside").getByRole("button", { name: /^(Activity|Extracting|Fetching preview|Auto-tagging|Applying lens)/ });
const activity = (page: Page) => page.getByRole("dialog", { name: "Activity" });
const jobRows = (page: Page): Locator => activity(page).locator("div.rounded-md");
const failureBadge = (page: Page) => page.locator("main").getByText(/^(No preview|Context failed)$/);

/** Opens Add link, pastes `text` and saves. */
async function addLinks({ page, click, paste }: Pick<ScenarioContext, "page" | "click" | "paste">, text: string) {
  await click(page.getByRole("button", { name: "Add link" }));
  await paste(page.getByRole("textbox"), text);
  await click(page.getByRole("button", { name: /^Save/ }));
}

/** Nothing is in Needs attention: API (every link) and UI (no sidebar entry, no failure badge). */
async function noAttention(page: Page, api: Api) {
  const lib = await api.library();
  const flagged = lib.links.filter((l) => l.attention_kind);
  if (flagged.length) throw new Error(`attention on ${flagged.map((l) => l.url).join(", ")}`);
  if (await attentionNav(page).isVisible()) throw new Error("Needs attention appeared in the sidebar");
  if (await failureBadge(page).first().isVisible()) throw new Error("a failure badge is shown");
  return lib;
}

/** Waiting = processing, not failed: pending status and no attention on every link still busy. */
const waitingNotFailed = (links: Awaited<ReturnType<Api["library"]>>["links"]) =>
  links.filter((l) => l.processing).every((l) => l.status !== "failed" && l.content_state !== "failed" && !l.attention_kind);

export default chapter({
  id: "ch1-waiting",
  title: "Waiting is not failing",
  ticket: "FAC-48",
  summary: [
    "Adding links still works: saved, duplicate, several at once, invalid text",
    "Six links wait behind one browser slot for about a minute; none enters Needs attention, not even after a reload",
    "Activity labels the jobs that wait for the slot",
    "Cancelling an import leaves the links neutral (“No preview yet”), and Fetch preview fills one in on demand",
  ],
  env: { vars: { BROWSER_CONCURRENCY: "1" } },
  scenarios: [
    scenario("RG-02", "RG-02: Add link, duplicate, paste many, invalid text", {
      ticket: "FAC-48 (regression)",
      covers: "RG-02: the Add link dialog still saves one link, spots a duplicate, saves several at once and rejects text without links.",
      expected: "“Link saved”, then “Already in your library”, then “3 links saved”; invalid text shows “Paste http or https links, separated by spaces or new lines.”",
    }, async ({ page, step, click, paste, type, expect, api, fixture }) => {
      const one = fixture("article", "one");
      await step("Add one link", "Toast “Link saved”; the link is in the library");
      await click(page.getByRole("button", { name: "Add link" }));
      await type(page.getByRole("textbox"), one);
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await expect("API: the link is saved", async () => !!(await api.link(one)));
      await expect.visible(page.getByText("QA article rg-02/one", { exact: true }), "The row shows the page title");

      await step("Add the same link again", "Toast “Already in your library”; still one link");
      await addLinks({ page, click, paste }, one);
      await expect.visible(page.getByText("Already in your library", { exact: true }), "Toast: Already in your library");
      await expect("API: still one link", async () => (await api.library()).links.length === 1);

      await step("Paste three links at once", "Toast “3 links saved”; four links in total");
      const three = ["a", "b", "c"].map((p) => fixture("article", p));
      await addLinks({ page, click, paste }, three.join("\n"));
      await expect.visible(page.getByText("3 links saved", { exact: true }), "Toast: 3 links saved");
      await expect("API: four links in the library", async () => (await api.library()).links.length === 4);

      await step("Paste text with no link in it", "The dialog refuses it with a plain message");
      await click(page.getByRole("button", { name: "Add link" }));
      await paste(page.getByRole("textbox"), "just some words, no link here");
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect.visible(page.getByRole("alert").getByText("Paste http or https links, separated by spaces or new lines."), "Message: Paste http or https links…");
      await expect("API: nothing new was saved", async () => (await api.library()).links.length === 4);
      await page.keyboard.press("Escape");
      await expect("Every link ends ready, none in Needs attention", async () =>
        (await api.library()).links.every((l) => !l.processing && l.status === "ready" && !l.attention_kind), { timeout: 30_000 });
    }),

    scenario("NA-01", "NA-01 + NA-02: about a minute behind one browser slot, with a reload, never enters Needs attention", {
      ticket: "FAC-48",
      covers: "NA-01 (repro A: a queue wait over 30 s is not a failure) and NA-02 (a reload during the wait keeps the links processing). Supersedes pilot P1.",
      expected: "The waiting rows read “Fetching title and preview…” with “Extracting…”, offer no Retry/Fetch preview, survive a reload, and all six end ready. Needs attention never appears.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      // Two slow-but-healthy pages first (~28 s each in the single browser slot), then four quick ones.
      const urls = [fixture("slow-ok", "1"), fixture("slow-ok", "2"), ...[1, 2, 3, 4].map((i) => fixture("article", String(i)))];
      await step("Paste six links at once (two slow pages first; only one page renders at a time)", "All six are saved and wait their turn");
      await addLinks({ page, click, paste }, urls.join("\n"));
      await expect.visible(page.getByText("6 links saved", { exact: true }), "Toast: 6 links saved");
      await expect("API: six links, all processing", async () => {
        const links = (await api.library()).links;
        return links.length === 6 && links.every((l) => l.processing);
      }, { timeout: 10_000 });
      const t0 = Date.now();
      const quick = page.locator("main article").filter({ hasText: "article.qa.example" }).first();
      await expect.visible(page.locator("main article").filter({ hasText: "Fetching title and preview…" }).filter({ hasText: "Extracting…" }).first(),
        "Waiting rows read “Fetching title and preview…” with an “Extracting…” badge");

      await step("Open the menu of a waiting row", "No “Retry preview” and no “Fetch preview” while it waits");
      await click(quick.getByRole("button", { name: "Link actions" }));
      await expect.visible(page.getByRole("menuitem", { name: "Copy URL" }), "The row menu is open");
      await expect.hidden(page.getByRole("menuitem", { name: /Retry preview|Fetch preview/ }), "No Retry preview / Fetch preview in the menu");
      await page.keyboard.press("Escape");

      await step("Wait past 30 s while the quick links are still queued behind the slow ones", "Nothing enters Needs attention; no failure badge");
      await expect.holds("No link in Needs attention, no waiting link failed", Math.max(5_000, 38_000 - (Date.now() - t0)), async () =>
        waitingNotFailed((await noAttention(page, api)).links));
      await expect(`At ${Math.round((Date.now() - t0) / 1000)} s at least two links are still waiting (API: processing, not failed)`, async () => {
        const waiting = (await api.library()).links.filter((l) => l.processing);
        return Date.now() - t0 >= 30_000 && waiting.filter((l) => l.status === "pending").length >= 2 && waiting.every((l) => l.status !== "failed" && !l.attention_kind);
      }, { timeout: 2_000 });

      await step("NA-02: reload the page while links are still waiting", "The same rows still read “Fetching title and preview…”; no Needs attention");
      await page.reload();
      await expect.visible(page.locator("main article").filter({ hasText: "Fetching title and preview…" }).first(), "After the reload, waiting rows still read “Fetching title and preview…”");
      await expect("API after the reload: waiting links are still processing, none failed", async () => {
        const waiting = (await api.library()).links.filter((l) => l.processing);
        return waiting.length >= 1 && waiting.every((l) => l.status !== "failed" && !l.attention_kind);
      }, { timeout: 3_000 });

      await step("Keep waiting until the queue drains (about a minute in all)", "Still nothing in Needs attention");
      await expect.holds("No link in Needs attention while the rest wait", Math.max(3_000, 58_000 - (Date.now() - t0)), async () =>
        waitingNotFailed((await noAttention(page, api)).links));
      await expect("Every link ends ready with its content", async () => {
        const links = (await api.library()).links;
        return links.length === 6 && links.every((l) => !l.processing && l.status === "ready" && l.content_state === "ready" && !l.attention_kind);
      }, { timeout: 40_000 });
      await expect(`The last link waited ${Math.round((Date.now() - t0) / 1000)} s in all (> 30 s)`, () => Date.now() - t0 > 30_000);
      await expect.visible(page.getByText("QA article na-01/4", { exact: true }), "The last queued link shows its real title");
      await expect.hidden(attentionNav(page), "Sidebar shows no Needs attention entry");
    }),

    scenario("NA-03", "NA-03: Activity labels the jobs waiting for the browser slot “Queued”", {
      ticket: "FAC-48 (S10)",
      covers: "NA-03: jobs that have not started read “Queued” in Activity, never the legacy Spanish “En cola”.",
      expected: "While the slow page holds the only slot, the other two jobs read “Queued” under Extract context. “En cola” never appears.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const urls = [fixture("slow-ok", "1"), fixture("article", "1"), fixture("article", "2")];
      await step("Paste three links (a slow page first; one browser slot)", "Two jobs wait for the slow one");
      await addLinks({ page, click, paste }, urls.join("\n"));
      await expect.visible(page.getByText("3 links saved", { exact: true }), "Toast: 3 links saved");

      await step("Open Activity and expand Extract context", "Each job is listed with its state");
      await click(activityNav(page));
      await click(activity(page).getByText("Extract context", { exact: true }));
      await expect("Three jobs listed", async () => (await jobRows(page).count()) === 3, { timeout: 10_000 });
      await expect("API: the two quick links have not started (no preview yet)", async () => {
        const waiting = (await api.library()).links.filter((l) => l.url.includes("article.qa.example") && l.processing && l.status === "pending");
        return waiting.length === 2;
      }, { timeout: 5_000 });
      await expect.holds("“En cola” never appears", 4_000, async () => !(await activity(page).getByText("En cola").isVisible()));

      await step("Look at the two jobs behind the slow page", "They read “Queued”");
      await expect("Both waiting jobs read “Queued”", async () => {
        const rows = (await jobRows(page).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
        if (rows.filter((t) => t.endsWith("Queued")).length === 2) return true;
        throw new Error(`Activity reads: ${rows.join(" | ")}`);
      }, { timeout: 8_000 });
    }),

    scenario("NA-04", "NA-04: cancelling an import before the queued links start leaves them neutral", {
      ticket: "FAC-48",
      covers: "NA-04 (repro F): a cancelled import is “as if nothing happened”. The plan cancels the batch while the slow page holds the only slot.",
      expected: "“Cancelled 3 queued jobs”; the three rows read “No preview yet” with no badge and stay out of Needs attention.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const urls = [fixture("slow-ok", "1"), ...[1, 2, 3].map((i) => fixture("article", String(i)))];
      await step("Import four links (a slow page first; one browser slot)", "Three of them wait for the slow one");
      await addLinks({ page, click, paste }, urls.join("\n"));
      await expect.visible(page.getByText("4 links saved", { exact: true }), "Toast: 4 links saved");
      await expect("API: the three quick links are still waiting (no preview fetched)", async () => {
        const links = (await api.library()).links.filter((l) => l.url.includes("article.qa.example"));
        return links.length === 3 && links.every((l) => l.processing && l.status === "pending");
      }, { timeout: 5_000 });

      await step("Open Activity and cancel the Extract context batch", "The three waiting jobs are cancelled");
      await click(activityNav(page));
      const cancelled = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/batches/"));
      await click(activity(page).getByRole("button", { name: "Cancel batch", exact: true }));
      const reply = await (await cancelled).json() as { cancelled?: number };
      // Toasts live ~4 s: keep every text seen while polling, so a failure names what the user actually read.
      const seen = new Set<string>();
      await expect("Toast: Cancelled 3 queued jobs", async () => {
        for (const t of await page.locator("[data-sonner-toast]").allInnerTexts()) seen.add(t.replace(/\s+/g, " ").trim());
        if ([...seen].some((t) => t.includes("Cancelled 3 queued jobs"))) return true;
        throw new Error(`toast reads: ${[...seen].join(" | ") || "(none)"}; the API cancelled ${reply.cancelled ?? 0} jobs`);
      }, { timeout: 4_000 });
      await expect("API: the three quick links are neutral (pending, no content, not processing, no attention)", async () => {
        const links = (await api.library()).links.filter((l) => l.url.includes("article.qa.example"));
        return links.every((l) => !l.processing && l.status === "pending" && l.content_state === "missing" && !l.attention_kind);
      }, { timeout: 10_000 });
    }),

    scenario("NA-05", "NA-04 + NA-05: links cancelled one by one stay neutral; Fetch preview fills one in", {
      ticket: "FAC-48",
      covers: "NA-04's neutral state (cancelled with each job's ✕ in Activity, since the batch Cancel does not reach jobs waiting for a slot) and NA-05 (Fetch preview runs a queued preview job).",
      expected: "Cancelled rows read “No preview yet” with no badge, stay out of Needs attention for over 60 s and after a reload; Inspector shows “Not fetched yet · Fetch” and “No context yet”. Fetch preview adds a “Fetch preview” batch, fills the title and leaves the content empty.",
    }, async ({ page, step, click, paste, expect, api, fixture, hold }) => {
      const urls = [fixture("slow-ok", "1"), ...[1, 2, 3].map((i) => fixture("article", String(i)))];
      const quick = () => api.library().then((lib) => lib.links.filter((l) => l.url.includes("article.qa.example")));
      await step("Import four links (a slow page first; one browser slot)", "Three of them wait for the slow one");
      await addLinks({ page, click, paste }, urls.join("\n"));
      await expect.visible(page.getByText("4 links saved", { exact: true }), "Toast: 4 links saved");
      await expect("API: the three quick links are waiting (no preview fetched)", async () => {
        const links = await quick();
        return links.length === 3 && links.every((l) => l.processing && l.status === "pending");
      }, { timeout: 5_000 });

      await step("In Activity, cancel the three waiting jobs with their ✕", "Each one is cancelled before it fetched anything");
      await click(activityNav(page));
      await click(activity(page).getByText("Extract context", { exact: true }));
      for (let i = 0; i < 3; i++) {
        const row = jobRows(page).filter({ hasText: "Preparing content" }).first();
        await click(row.getByRole("button", { name: "Cancel", exact: true }));
        await expect(`Job ${i + 1} of 3 cancelled`, async () => (await jobRows(page).filter({ hasText: "Cancelled" }).count()) >= i + 1, { timeout: 10_000 });
      }
      await expect("API: the three quick links are neutral (pending, content missing, not processing, no attention)", async () =>
        (await quick()).every((l) => !l.processing && l.status === "pending" && l.content_state === "missing" && !l.attention_kind), { timeout: 10_000 });
      await page.keyboard.press("Escape");
      const t0 = Date.now();
      const neutralRows = page.locator("main article").filter({ hasText: "No preview yet" });
      await expect("Three rows read “No preview yet”", async () => (await neutralRows.count()) === 3, { timeout: 10_000 });
      await expect("…with no spinner badge and no failure badge", async () =>
        (await neutralRows.filter({ hasText: /Extracting…|Fetching preview…|No preview$|Context failed/ }).count()) === 0);

      await step("Wait more than 60 s", "They stay neutral and out of Needs attention");
      await expect.holds("Cancelled links stay neutral, nothing in Needs attention", 61_000 - (Date.now() - t0), async () => {
        const links = await quick();
        return links.every((l) => !l.processing && l.status === "pending" && !l.attention_kind) && (await noAttention(page, api));
      });

      await step("Reload", "Same rows, still neutral");
      await page.reload();
      await expect("After the reload: three rows read “No preview yet”", async () => (await neutralRows.count()) === 3, { timeout: 10_000 });
      await expect.hidden(attentionNav(page), "No Needs attention entry after the reload");

      await step("Open one of them in the Inspector", "Preview “Not fetched yet · Fetch”; content “No context yet”");
      await click(neutralRows.first().locator("p").first());
      await expect.visible(page.getByText("No context yet", { exact: true }), "Content: “No context yet”");
      await click(page.getByRole("tab", { name: "Details" }));
      await expect.visible(page.locator("dd").filter({ hasText: /^Not fetched yet · Fetch$/ }), "Preview: “Not fetched yet · Fetch”");

      await step("Fetch its preview from the row menu", "A “Fetch preview” job runs; the title and description appear; no content");
      const target = neutralRows.first();
      const title = (await target.locator("p").first().innerText()).trim();
      await click(target.getByRole("button", { name: "Link actions" }));
      await click(page.getByRole("menuitem", { name: "Fetch preview" }));
      const fetched = async () => (await quick()).find((l) => l.status === "ready");
      await expect("API: a preview batch was created for it", async () => (await api.library()).batches.some((b: any) => b.kind === "preview"), { timeout: 5_000 });
      await expect("API: its preview is ready, content still missing, no attention", async () => {
        const l = await fetched();
        return l && !l.processing && l.content_state === "missing" && !l.attention_kind && l.title.startsWith("QA article");
      }, { timeout: 20_000 });
      const l = (await fetched())!;
      await expect.visible(page.locator("main").getByText(l.title, { exact: true }), `The row now shows “${l.title}” (was “${title}”)`);
      await expect.visible(page.locator("main").getByText("A normal page.").first(), "…and its description");
      await click(activityNav(page));
      await expect.visible(activity(page).getByText("Fetch preview", { exact: true }), "Activity lists a “Fetch preview” batch");
      await page.keyboard.press("Escape");
      await hold(1_500, "Content stays empty");
      await click(page.locator("main article").getByText(l.title, { exact: true }));
      await expect.visible(page.getByText("No context yet", { exact: true }), "Inspector content still reads “No context yet”");
      await expect.hidden(attentionNav(page), "It never entered Needs attention");
    }),
  ],
});
