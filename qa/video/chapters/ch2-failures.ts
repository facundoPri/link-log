// Chapter 2 "Failures that explain themselves" (FAC-48 core, part 2): planning/qa/fac-48-test-plan.md §12.
// Profile FIX with the preview fallback off (the default). Product retry timing (preview 5 s → 10 s, content
// 10 s) is kept on purpose, so "Waiting to retry" between attempts is on screen long enough to read.
import { resolve } from "node:path";
import type { Locator, Page } from "playwright-core";
import { chapter, scenario, type Api, type Expect, type ScenarioContext } from "../recorder";
import { OUT } from "../env";

const attentionNav = (page: Page) => page.locator("aside").getByRole("button", { name: /Needs attention/ });
const allLinksNav = (page: Page) => page.locator("aside").getByRole("button", { name: /^All links/ });
const activityNav = (page: Page) =>
  page.locator("aside").getByRole("button", { name: /^(Activity|Extracting|Fetching preview|Auto-tagging|Applying lens)/ });
const activity = (page: Page) => page.getByRole("dialog", { name: "Activity" });
const jobRows = (page: Page): Locator => activity(page).locator("div.rounded-md");
/** The library row of the link on this fixture host (one link per host in every scenario). */
const row = (page: Page, host: string) => page.locator("main article").filter({ hasText: `${host}.qa.example` });
const badge = (r: Locator, text: string) => r.getByText(text, { exact: true });

const PREVIEW_503 = "Couldn't get the preview: The site had a problem.";
const FILE = "Couldn't get the preview: This link is a file (like a PDF), not a web page.";
const EMPTY = "Couldn't get the content: The page returned no content. You can paste it manually.";
const DNS_CONTENT = "Couldn't get the content: The site could not be reached.";
const DNS_PREVIEW = "Couldn't get the preview: The site could not be reached.";
const BUSY = "Wait for the running job to finish.";

/** Opens Add link, pastes `text` and saves. */
async function addLinks({ page, click, paste }: Pick<ScenarioContext, "page" | "click" | "paste">, text: string) {
  await click(page.getByRole("button", { name: "Add link" }));
  await paste(page.getByRole("textbox"), text);
  await click(page.getByRole("button", { name: /^Save/ }));
}

/** The sidebar's Needs attention count, or 0 when the entry is gone. */
async function counter(page: Page) {
  const nav = attentionNav(page);
  if (!(await nav.isVisible())) return 0;
  return Number((await nav.innerText()).match(/(\d+)\s*$/)?.[1] ?? NaN);
}

/** Text of every Activity job row, whitespace-normalised. */
const activityText = async (page: Page) => (await jobRows(page).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).join(" | ");

/** `link_step_failed` lines the Worker logged for this job (the log can hold older runs; the job id is unique). */
async function stepFailures(jobId: string): Promise<any[]> {
  const text = await Bun.file(resolve(OUT, "logs/dev.log")).text();
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf('{"event":"link_step_failed"');
    if (at < 0) return [];
    try {
      const e = JSON.parse(line.slice(at));
      return e.job_id === jobId ? [e] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Polls until `done()` while requiring `invariant()` on every poll (a running job must never break it).
 * A violation is remembered and fails the check, naming what was seen.
 */
async function whileRunning(expect: Expect, name: string, done: () => Promise<boolean>, invariant: () => Promise<string | null>, timeout: number) {
  let broken: string | null = null;
  await expect(name, async () => {
    if (!broken) broken = await invariant();
    if (broken) throw new Error(broken);
    return done();
  }, { timeout });
}

/** The link's newest job (api.jobs is newest first). */
const latestJob = async (api: Api, url: string) => (await api.jobs(url))[0];

/** Usage rows recorded for one link. */
const usageRows = async (api: Api, linkId: string) => ((await api.get<{ events: any[] }>("/usage")).events ?? []).filter((e) => e.link_id === linkId).length;

/** The fields that decide Needs attention and what the row shows. */
const snapshot = (links: Awaited<ReturnType<Api["library"]>>["links"]) =>
  JSON.stringify(links.map((l) => [l.id, l.attention_kind, l.attention_reason, l.attention_at, l.status, l.content_state, l.preview_reason, l.content_reason]).sort());

/** Inspector → Paste text → `text` → Save, for the row given. */
async function pasteContent({ page, click, paste }: Pick<ScenarioContext, "page" | "click" | "paste">, r: Locator, text: string) {
  await click(r.locator("p").first());
  await click(page.getByRole("button", { name: "Paste text", exact: true }));
  await paste(page.locator("textarea"), text);
  await click(page.getByRole("button", { name: "Save", exact: true }));
}

export default chapter({
  id: "ch2-failures",
  title: "Failures that explain themselves",
  ticket: "FAC-48",
  summary: [
    "A site error is retried in plain sight: “Attempt 2 of 3 · Waiting to retry” with the previous reason",
    "A file link fails at once, and Retry re-runs only the preview, without leaving the list",
    "Empty content: one attempt, Retry runs only the content step, nothing can start twice, and pasting fixes it",
    "An unreachable site fails on both axes; once the content is pasted, the preview reason takes over",
    "Dismiss (button and menu) changes nothing else; a new failure brings it back; reloads change nothing",
  ],
  scenarios: [
    scenario("NA-07", "NA-07: a site error is retried visibly and enters Needs attention only after the last attempt", {
      ticket: "FAC-48 (AC2, AC3)",
      covers: "NA-07: a transient preview failure (503) is retried 3 times with its attempts and timing in Activity, and is only flagged once the job is over.",
      expected: "Activity shows “Attempt N of 3 · Ns of 20s”, then “Attempt 2 of 3 · Waiting to retry” with “Previous attempt: The site had a problem.”. Not flagged while running; then “Couldn't get the preview: The site had a problem.” with Retry and Dismiss.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("preview-down", "page");
      await step("Add a link whose site answers 503 (the page reader still works)", "The link is saved and its job starts");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");

      await step("Open Activity → Extract context and watch the job", "The attempt number and its elapsed time against the 20 s budget");
      await click(activityNav(page));
      await click(activity(page).getByText("Extract context", { exact: true }));
      await expect("Activity: “Fetching preview · Attempt 1 of 3 · Ns of 20s”", async () =>
        /Fetching preview · Attempt 1 of 3 · \d+s of 20s/.test(await activityText(page)), { timeout: 10_000 });

      await step("The first attempt fails: the job waits 5 s before the next one", "“Attempt 2 of 3 · Waiting to retry” with the previous reason");
      await expect("API during the backoff: attempt 2 of 3, reason site_error, no attempt running", async () => {
        const j = await latestJob(api, url);
        return j && j.attempt === 2 && j.max_attempts === 3 && j.reason === "site_error" && j.attempt_started_at === null && j.status === "running";
      }, { timeout: 10_000 });
      await expect("Activity: “Fetching preview · Attempt 2 of 3 · Waiting to retry”", async () =>
        (await activityText(page)).includes("Fetching preview · Attempt 2 of 3 · Waiting to retry"), { timeout: 5_000 });
      await expect.visible(activity(page).getByText("Previous attempt: The site had a problem.", { exact: true }), "Activity note: “Previous attempt: The site had a problem.”");
      await expect("Activity: “Attempt 3 of 3”", async () => /Attempt 3 of 3/.test(await activityText(page)), { timeout: 20_000 });

      await step("Wait for the job to end", "The link is not in Needs attention while the job still runs");
      await whileRunning(expect, "Never in Needs attention while the job runs (API and sidebar, every 0.4 s)",
        async () => !(await api.link(url))?.processing,
        async () => {
          const l = await api.link(url);
          if (l?.processing && l.attention_kind) return `flagged while running: ${l.attention_kind}`;
          if (l?.processing && (await attentionNav(page).isVisible())) return "Needs attention appeared while the job ran";
          return null;
        }, 40_000);
      await expect("API: preview attention site_error; the content was still extracted", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === "preview" && l.attention_reason === "site_error" && l.status === "failed" && l.content_state === "ready";
      }, { timeout: 5_000 });
      await expect.visible(activity(page).getByText("No preview: The site had a problem.", { exact: true }), "Activity: the job is done, noting “No preview: The site had a problem.”");
      const job = await latestJob(api, url);
      await expect("Log: 3 preview failures, attempts 1/2/3, final only on the 3rd", async () => {
        const lines = (await stepFailures(job.id)).filter((e) => e.step === "preview");
        const ok = lines.length === 3 && lines.map((e) => `${e.attempt}:${e.final}`).join() === "1:false,2:false,3:true"
          && lines.every((e) => e.reason === "site_error" && e.http_status === 503 && e.adapter === "preview" && e.max_attempts === 3);
        if (!ok) throw new Error(`log has ${JSON.stringify(lines.map((e) => [e.attempt, e.final, e.reason, e.http_status]))}`);
        return true;
      }, { timeout: 5_000 });
      await page.keyboard.press("Escape");

      await step("Look at the row", "Plain reason with Retry and Dismiss, a “No preview” badge, and Needs attention (1)");
      const r = row(page, "preview-down");
      await expect.visible(r.getByText(PREVIEW_503, { exact: true }), `Row: “${PREVIEW_503}”`);
      await expect.visible(r.getByRole("button", { name: "Retry", exact: true }), "Retry is offered");
      await expect.visible(r.getByRole("button", { name: "Dismiss", exact: true }), "Dismiss is offered");
      await expect.visible(badge(r, "No preview"), "Badge: No preview");
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1);
    }),

    scenario("NA-10", "NA-10 + NA-19: a file link fails fast; Retry re-runs only the preview and never leaves the list", {
      ticket: "FAC-48 (AC2, AC3)",
      covers: "NA-10: a non-HTML link fails after one attempt with a readable reason. NA-19: its Retry is a preview-only job; the row stays in Needs attention, without flicker, and fails the same way.",
      expected: "One attempt, then “Couldn't get the preview: This link is a file (like a PDF), not a web page.”. Retry adds a “Fetch preview” batch; the row stays listed with “Fetching preview…”, the counter stays at 1, no content is re-extracted, and the same reason returns.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("file", "paper.pdf");
      await step("Add a link to a file (the site answers application/pdf)", "The preview fails at once: no second attempt");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await click(activityNav(page));
      await click(activity(page).getByText("Extract context", { exact: true }));
      await whileRunning(expect, "Activity never shows “Attempt 2”, and nothing is flagged while it runs",
        async () => !!(await api.link(url)) && !(await api.link(url))!.processing,
        async () => {
          if (/Attempt 2/.test(await activityText(page))) return `Activity reads: ${await activityText(page)}`;
          const l = await api.link(url);
          return l?.processing && l.attention_kind ? "flagged while running" : null;
        }, 30_000);
      const job = await latestJob(api, url);
      await expect("Log: one preview failure, attempt 1, final, not_html, application/pdf", async () => {
        const lines = (await stepFailures(job.id)).filter((e) => e.step === "preview");
        const ok = lines.length === 1 && lines[0].attempt === 1 && lines[0].final === true && lines[0].reason === "not_html" && lines[0].content_type === "application/pdf" && lines[0].retryable === false;
        if (!ok) throw new Error(`log has ${JSON.stringify(lines)}`);
        return true;
      }, { timeout: 5_000 });
      await expect("API: preview attention not_html", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === "preview" && l.attention_reason === "not_html" && l.status === "failed";
      });
      await expect.visible(activity(page).getByText("No preview: This link is a file (like a PDF), not a web page.", { exact: true }), "Activity: the job notes “No preview: This link is a file…”");
      await page.keyboard.press("Escape");

      const r = row(page, "file");
      await expect.visible(r.getByText(FILE, { exact: true }), `Row: “${FILE}”`);
      await expect.visible(r.getByRole("button", { name: "Retry", exact: true }), "Retry is offered");
      await expect.visible(r.getByRole("button", { name: "Dismiss", exact: true }), "Dismiss is offered");
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1);

      await step("Open it in the Inspector → Details", "Preview: “Failed · This link is a file (like a PDF), not a web page.”");
      await click(r.locator("p").first());
      await click(page.getByRole("tab", { name: "Details" }));
      await expect.visible(page.locator("dd").filter({ hasText: /^Failed · This link is a file \(like a PDF\), not a web page\./ }), "Inspector: “Failed · This link is a file (like a PDF), not a web page.”");

      await step("NA-19: filter by Needs attention and click Retry on the row", "A preview-only job; the row stays listed and the counter stays at 1");
      await click(attentionNav(page));
      await expect.visible(page.getByRole("heading", { level: 1, name: /Needs attention/ }), "The list is filtered by Needs attention");
      const link = (await api.link(url))!;
      const usageBefore = await usageRows(api, link.id);
      const jobsBefore = (await api.jobs(url)).length;
      await click(r.getByRole("button", { name: "Retry", exact: true }));
      await expect("While it runs: “Fetching preview…” badge, no Retry or Dismiss on the row", async () =>
        (await badge(r, "Fetching preview…").isVisible()) && !(await r.getByRole("button", { name: /^(Retry|Dismiss)$/ }).count()), { timeout: 8_000 });
      await whileRunning(expect, "Row stays in the filtered list, counter stays 1, API keeps preview attention (every 0.4 s)",
        async () => {
          const jobs = await api.jobs(url);
          return jobs.length > jobsBefore && !["queued", "running", "waiting"].includes(jobs[0].status);
        },
        async () => {
          const l = await api.link(url);
          if (l?.attention_kind !== "preview") return `API attention became ${l?.attention_kind}`;
          if ((await r.count()) !== 1) return "the row left the filtered list";
          const n = await counter(page);
          return n === 1 ? null : `counter read ${n}`;
        }, 30_000);
      const retry = await latestJob(api, url);
      await expect("API: the retry was a “preview” batch (one job, failed not_html)", async () => retry.kind === "preview" && retry.status === "failed" && retry.reason === "not_html");
      await expect("Usage: no new page-reader call (content was not re-extracted)", async () => (await usageRows(api, link.id)) === usageBefore);
      await expect.visible(r.getByText(FILE, { exact: true }), "Same reason after the retry");
      await click(activityNav(page));
      await expect.visible(activity(page).getByText("Fetch preview", { exact: true }), "Activity lists a “Fetch preview” batch");
      await page.keyboard.press("Escape");

      await step("Reload", "The same row, reason and counter");
      await page.reload();
      await expect.visible(row(page, "file").getByText(FILE, { exact: true }), "After the reload: same reason on the row");
      await expect("After the reload: Needs attention (1)", async () => (await counter(page)) === 1, { timeout: 8_000 });
    }),

    scenario("NA-16", "NA-16 + NA-20 + NA-26: empty content fails once; Retry runs only the content step; nothing can start twice; Paste fixes it", {
      ticket: "FAC-48 (AC2, AC3)",
      covers: "NA-16: content failure with a working preview. NA-20: content-only Retry starts at “Extracting content”, then Paste text resolves it. NA-26: while a job runs, no Retry/Use preview/Dismiss and the API refuses both.",
      expected: "“Couldn't get the content: The page returned no content. You can paste it manually.” with Context failed, Retry, Use preview and Dismiss. The retry never fetches the preview, the API answers “Wait for the running job to finish.”, and the pasted text clears Needs attention.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("empty-slow", "page");
      await step("Add a link whose preview works but whose page is empty (the reader answers after 15 s)", "One content attempt, then the content failure");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await whileRunning(expect, "Not in Needs attention while it extracts",
        async () => !!(await api.link(url)) && !(await api.link(url))!.processing,
        async () => {
          const l = await api.link(url);
          return l?.processing && (l.attention_kind || (await attentionNav(page).isVisible())) ? "flagged while running" : null;
        }, 40_000);
      await expect("API: content attention “empty”, preview ready", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === "content" && l.attention_reason === "empty" && l.status === "ready" && l.content_state === "failed";
      });
      const first = await latestJob(api, url);
      await expect("Log: exactly one content attempt (web adapter, final, empty)", async () => {
        const lines = (await stepFailures(first.id)).filter((e) => e.step === "content");
        const ok = lines.length === 1 && lines[0].attempt === 1 && lines[0].final === true && lines[0].reason === "empty" && lines[0].adapter === "web";
        if (!ok) throw new Error(`log has ${JSON.stringify(lines)}`);
        return true;
      }, { timeout: 5_000 });
      const r = row(page, "empty-slow");
      await expect.visible(r.getByText(EMPTY, { exact: true }), "Row: “Couldn't get the content: The page returned no content…”");
      await expect.visible(badge(r, "Context failed"), "Badge: Context failed");
      for (const name of ["Retry", "Use preview", "Dismiss"])
        await expect.visible(r.getByRole("button", { name, exact: true }), `${name} is offered`);
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1);

      await step("NA-20: click Retry on the row", "Only the content step runs again");
      const jobsBefore = (await api.jobs(url)).length;
      await click(r.getByRole("button", { name: "Retry", exact: true }));
      await expect("API: a new Extract context job runs", async () => {
        const jobs = await api.jobs(url);
        return jobs.length > jobsBefore && jobs[0].kind === "extract" && jobs[0].status === "running";
      }, { timeout: 8_000 });
      const retry = await latestJob(api, url);
      const link = (await api.link(url))!;

      await step("NA-26: while it runs, look at the row and try Retry / Use preview through the API", "No Retry, Use preview or Dismiss; the API answers “Wait for the running job to finish.”");
      await expect("Row: “Extracting…” badge and no Retry / Use preview / Dismiss", async () =>
        (await badge(r, "Extracting…").isVisible()) && !(await r.getByRole("button", { name: /^(Retry|Use preview|Dismiss)$/ }).count()), { timeout: 5_000 });
      await click(r.getByRole("button", { name: "Link actions" }));
      await expect.visible(page.getByRole("menuitem", { name: "Copy URL" }), "The row menu is open");
      await expect.hidden(page.getByRole("menuitem", { name: /Retry preview|Fetch preview|Use preview as content/ }), "Menu: no Retry preview / Fetch preview / Use preview");
      await page.keyboard.press("Escape");
      const refused = async (path: string, body: unknown) => {
        try {
          await api.send("POST", path, body);
          return "accepted";
        } catch (e) {
          return String((e as Error).message);
        }
      };
      const retryReply = await refused(`/links/${link.id}/retry`, { step: "content" });
      await expect(`API POST /retry → ${retryReply.replace(/^POST \S+ → /, "")}`, () => retryReply.includes("400") && retryReply.includes(BUSY));
      const useReply = await refused(`/links/${link.id}/use-preview`, {});
      await expect(`API POST /use-preview → ${useReply.replace(/^POST \S+ → /, "")}`, () => useReply.includes("400") && useReply.includes(BUSY));
      await expect("API: still exactly one active job on the link", async () =>
        (await api.jobs(url)).filter((j) => ["queued", "running", "waiting"].includes(j.status)).length === 1);

      await step("Open Activity and watch the retry", "It goes straight to “Extracting content”, never “Fetching preview”");
      await click(activityNav(page));
      await click(activity(page).getByText("Extract context", { exact: true }).first());
      await expect("Activity: “Extracting content · Attempt 1 of 2 · Ns of 1m 40s”", async () =>
        /Extracting content · Attempt 1 of 2 · \d+s of 1m 40s/.test(await activityText(page)), { timeout: 8_000 });
      await whileRunning(expect, "The retry never fetches the preview; the link stays listed (every 0.4 s)",
        async () => (await api.jobs(url)).find((j) => j.id === retry.id)?.status === "failed",
        async () => {
          const j = (await api.jobs(url)).find((x) => x.id === retry.id);
          if (j?.step === "Fetching preview") return "the retry fetched the preview";
          const l = await api.link(url);
          return l?.attention_kind === "content" ? null : `attention became ${l?.attention_kind}`;
        }, 30_000);
      await expect("Log: the retry logged only a content failure", async () => {
        const lines = await stepFailures(retry.id);
        if (lines.length !== 1 || lines[0].step !== "content" || lines[0].reason !== "empty") throw new Error(`log has ${JSON.stringify(lines.map((e) => [e.step, e.reason]))}`);
        return true;
      }, { timeout: 5_000 });
      await page.keyboard.press("Escape");
      await expect.visible(r.getByText(EMPTY, { exact: true }), "The retry fails with the same reason");

      await step("Inspector → Paste text “QA pasted body” → Save", "The link leaves Needs attention; the counter drops to 0");
      await pasteContent({ page, click, paste }, r, "QA pasted body");
      await expect("API: content ready (manual), attention cleared", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === null && l.content_state === "ready";
      }, { timeout: 8_000 });
      await expect.hidden(attentionNav(page), "Sidebar: Needs attention is gone (1 → 0)");
      await expect.hidden(badge(r, "Context failed"), "Badge Context failed is gone");
    }),

    scenario("NA-09", "NA-09: an unreachable site is retried, then fails on both axes with the content reported first", {
      ticket: "FAC-48 (repro G)",
      covers: "NA-09: a DNS failure (`unreachable`, retryable per the plan) gets 3 preview and 2 content attempts, then both axes fail and the content reason is shown first.",
      expected: "Activity shows the preview retried (“Attempt 2 of 3”). The row ends with “Couldn't get the content: The site could not be reached.”, Context failed and No preview, Retry and Dismiss, no Use preview. The log has 3 preview and 2 content attempts.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("nowhere", "page");
      await step("Add a link whose host does not resolve", "Not flagged while it runs");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await click(activityNav(page));
      await click(activity(page).getByText("Extract context", { exact: true }));
      await whileRunning(expect, "Not in Needs attention while it runs",
        async () => !!(await api.link(url)) && !(await api.link(url))!.processing,
        async () => {
          const l = await api.link(url);
          return l?.processing && l.attention_kind ? "flagged while running" : null;
        }, 60_000);
      await expect("API: content attention “unreachable”, preview_reason “unreachable”", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === "content" && l.attention_reason === "unreachable" && l.preview_reason === "unreachable" && l.status === "failed" && l.content_state === "failed";
      });
      await page.keyboard.press("Escape");

      await step("Look at the row", "Content reason first, both badges, Retry and Dismiss, no Use preview");
      const r = row(page, "nowhere");
      await expect.visible(r.getByText(DNS_CONTENT, { exact: true }), `Row: “${DNS_CONTENT}”`);
      await expect.visible(badge(r, "Context failed"), "Badge: Context failed");
      await expect.visible(badge(r, "No preview"), "Badge: No preview");
      await expect.visible(r.getByRole("button", { name: "Retry", exact: true }), "Retry is offered");
      await expect.visible(r.getByRole("button", { name: "Dismiss", exact: true }), "Dismiss is offered");
      await expect.hidden(r.getByRole("button", { name: "Use preview", exact: true }), "No Use preview (there is no preview to use)");

      await step("Check how many attempts each step made (Worker log)", "Preview 3 attempts, content 2 (unreachable is retryable)");
      const job = await latestJob(api, url);
      await expect("Log: 3 preview attempts and 2 content attempts, final only on the last", async () => {
        const lines = await stepFailures(job.id);
        const seq = lines.map((e) => `${e.step}${e.attempt}${e.final ? "!" : ""}`).join();
        if (seq !== "preview1,preview2,preview3!,content1,content2!")
          throw new Error(`log has ${seq} (${lines.map((e) => `retryable:${e.retryable} ${e.detail}`).join("; ")})`);
        return true;
      }, { timeout: 5_000 });
    }),

    scenario("NA-21", "NA-21: both axes failed; pasting the content hands Needs attention to the preview reason", {
      ticket: "FAC-48 (S4 content first)",
      covers: "NA-21: on a link whose preview and content both failed (unreachable host), a pasted content clears the content failure and the preview warning takes over.",
      expected: "Before: “Couldn't get the content: The site could not be reached.”. After the paste: “Couldn't get the preview: The site could not be reached.”, Context failed gone, No preview kept, still Needs attention (1).",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const url = fixture("nowhere", "page");
      await step("Add a link whose host does not resolve", "Preview and content both fail; the content is reported first");
      await addLinks({ page, click, paste }, url);
      await expect.visible(page.getByText("Link saved", { exact: true }), "Toast: Link saved");
      await expect("API: content attention “unreachable”, preview failed too", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.attention_kind === "content" && l.attention_reason === "unreachable" && l.status === "failed";
      }, { timeout: 60_000 });
      const r = row(page, "nowhere");
      await expect.visible(r.getByText(DNS_CONTENT, { exact: true }), `Row: “${DNS_CONTENT}”`);
      await expect.visible(badge(r, "Context failed"), "Badge: Context failed");

      await step("Paste the content in the Inspector", "Still in Needs attention, now for the preview");
      await pasteContent({ page, click, paste }, r, "QA pasted body for an unreachable site");
      await expect("API: preview attention “unreachable”, content ready", async () => {
        const l = await api.link(url);
        return l && l.attention_kind === "preview" && l.attention_reason === "unreachable" && l.content_state === "ready";
      }, { timeout: 8_000 });
      await expect.visible(r.getByText(DNS_PREVIEW, { exact: true }), `Row: “${DNS_PREVIEW}”`);
      await expect.hidden(badge(r, "Context failed"), "Badge Context failed is gone");
      await expect.visible(badge(r, "No preview"), "Badge No preview stays");
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1);
    }),

    scenario("NA-23", "NA-23 + NA-24: Dismiss by button and by menu changes nothing else; a new failure brings it back", {
      ticket: "FAC-48 (AC2)",
      covers: "NA-23: Dismiss only leaves the list (2 → 1 → 0), survives a reload and keeps every other field. NA-24: the same failure after Dismiss raises it again.",
      expected: "The counter goes 2 → 1 → 0 and the entry disappears; All links still shows “No preview” and “Context failed”; status and reasons are unchanged. Extract context on the empty page brings it back with the same reason.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      const file = fixture("file", "doc.pdf"), empty = fixture("browser-empty", "page");
      await step("Add a file link and an empty page", "Both end in Needs attention: preview and content");
      await addLinks({ page, click, paste }, `${file}\n${empty}`);
      await expect.visible(page.getByText("2 links saved", { exact: true }), "Toast: 2 links saved");
      await expect("API: file → preview attention, empty page → content attention", async () => {
        const [f, e] = [await api.link(file), await api.link(empty)];
        return f?.attention_kind === "preview" && e?.attention_kind === "content" && !f.processing && !e.processing;
      }, { timeout: 30_000 });
      await expect("Sidebar: Needs attention (2)", async () => (await counter(page)) === 2, { timeout: 5_000 });
      const before = snapshot((await api.library()).links);

      await step("Filter by Needs attention and click Dismiss on the file row", "It leaves the list: 2 → 1");
      await click(attentionNav(page));
      await click(row(page, "file").getByRole("button", { name: "Dismiss", exact: true }));
      await expect("Sidebar: Needs attention (1)", async () => (await counter(page)) === 1, { timeout: 5_000 });
      await expect.hidden(row(page, "file"), "The file row left the filtered list");

      await step("Dismiss the empty page from its row menu", "1 → 0: the Needs attention entry disappears");
      await click(row(page, "browser-empty").getByRole("button", { name: "Link actions" }));
      await click(page.getByRole("menuitem", { name: "Dismiss from Needs attention" }));
      await expect.hidden(attentionNav(page), "Sidebar: the Needs attention entry is gone (0)");
      await expect("API: both dismissed; status, content state and reasons unchanged", async () => {
        const links = (await api.library()).links;
        const strip = (s: string) => JSON.stringify((JSON.parse(s) as unknown[][]).map((l) => [l[0], ...l.slice(4)]));
        return links.every((l) => l.attention_kind === null) && strip(snapshot(links)) === strip(before);
      });

      await step("Go to All links and reload", "The rows still show “No preview” and “Context failed”; still dismissed");
      await click(allLinksNav(page));
      await page.reload();
      await expect.visible(badge(row(page, "file"), "No preview"), "File row: badge No preview");
      await expect.visible(badge(row(page, "browser-empty"), "Context failed"), "Empty page row: badge Context failed");
      await expect.hidden(attentionNav(page), "After the reload: no Needs attention entry");

      await step("NA-24: Extract context again on the empty page (row menu)", "The same failure brings it back to Needs attention");
      await click(row(page, "browser-empty").getByRole("button", { name: "Link actions" }));
      await click(page.getByRole("menuitem", { name: "Extract context" }));
      await expect("API: back in Needs attention with content “empty”", async () => {
        const l = await api.link(empty);
        return l && !l.processing && l.attention_kind === "content" && l.attention_reason === "empty";
      }, { timeout: 30_000 });
      await expect.visible(row(page, "browser-empty").getByText(EMPTY, { exact: true }), "Row: the same reason again");
      await expect("Sidebar: Needs attention (1); the dismissed file stays out", async () => (await counter(page)) === 1 && (await api.link(file))?.attention_kind === null, { timeout: 5_000 });
    }),

    scenario("NA-30", "NA-30: reload and reprocess give the same Needs attention list", {
      ticket: "FAC-48 (AC4)",
      covers: "NA-30: the Needs attention members, reasons and counter are identical after a reload and after re-extracting a link that fails the same way; attention_at does not move.",
      expected: "Three links in Needs attention before and after a reload; re-extracting the empty page fails the same way and leaves every attention field, including attention_at, unchanged.",
    }, async ({ page, step, click, paste, expect, api, fixture, hold }) => {
      const urls = [fixture("file", "x.pdf"), fixture("browser-empty", "page"), fixture("gone", "page")];
      await step("Add three links that fail in different ways", "A file, an empty page and a missing page: Needs attention (3)");
      await addLinks({ page, click, paste }, urls.join("\n"));
      await expect.visible(page.getByText("3 links saved", { exact: true }), "Toast: 3 links saved");
      await expect("API: all three settled in Needs attention", async () =>
        (await api.library()).links.filter((l) => !l.processing && l.attention_kind).length === 3, { timeout: 30_000 });
      await expect("Sidebar: Needs attention (3)", async () => (await counter(page)) === 3, { timeout: 5_000 });
      const before = snapshot((await api.library()).links);
      await click(attentionNav(page));
      const reasons = page.locator("main article").getByText(/^Couldn't get the (preview|content): /);
      const messages = async () => (await reasons.allInnerTexts()).sort().join(" | ");
      await expect("The list shows the three reasons", async () => (await reasons.count()) === 3, { timeout: 5_000 });
      const shown = await messages();

      await step("Reload", "The same members, reasons and counter");
      await page.reload();
      await expect("After the reload: Needs attention (3)", async () => (await counter(page)) === 3, { timeout: 8_000 });
      await click(attentionNav(page));
      await expect("After the reload: the same three reasons", async () => (await messages()) === shown, { timeout: 5_000 });
      await expect("API: attention fields identical after the reload", async () => snapshot((await api.library()).links) === before);

      await step("Re-extract the empty page, which fails the same way", "Nothing changes, not even when it was flagged");
      const empty = row(page, "browser-empty");
      const jobsBefore = (await api.jobs(urls[1]!)).length;
      await click(empty.getByRole("button", { name: "Link actions" }));
      await click(page.getByRole("menuitem", { name: "Extract context" }));
      await whileRunning(expect, "The re-extract runs and fails again; the row stays listed and the counter stays 3",
        async () => {
          const jobs = await api.jobs(urls[1]!);
          return jobs.length > jobsBefore && jobs[0].status === "failed";
        },
        async () => {
          const n = await counter(page);
          return n === 3 ? null : `counter read ${n}`;
        }, 30_000);
      await expect("API: attention fields identical, attention_at unchanged", async () => snapshot((await api.library()).links) === before, { timeout: 5_000 });
      await hold(1_000, "Reload again");
      await page.reload();
      await click(attentionNav(page));
      await expect("After the second reload: the same three reasons and counter", async () => (await messages()) === shown && (await counter(page)) === 3, { timeout: 8_000 });
    }),
  ],
});
