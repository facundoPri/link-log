// Pilot chapter: proves the harness end to end on FAC-48's core behaviour.
import { chapter, scenario } from "../recorder";

const attentionNav = (page: import("playwright-core").Page) =>
  page.locator("aside").getByRole("button", { name: /Needs attention/ });

export default chapter({
  id: "pilot",
  title: "Needs attention only after a real failure",
  ticket: "FAC-48",
  // Superseded by ch1-waiting (P1 = NA-01) and chapter 2 (fail-fast reasons); kept as the harness smoke test.
  optional: true,
  summary: [
    "Eight links wait behind the 2-slot browser pool for more than 30 s and never show as failed",
    "A preview that fails fast (HTTP 404) lands in Needs attention with its plain reason, Retry and Dismiss",
  ],
  scenarios: [
    scenario("P1", "Links queued behind the browser pool never enter Needs attention", {
      ticket: "FAC-48",
      covers: "Original repro A: a link that is still queued or waiting for a slot after 30 s is not a failure (the 30 s virtual 'failed' is gone).",
      expected: "All 8 links stay out of Needs attention while they wait (> 30 s for the last ones) and finish with preview and content, nothing to fix.",
    }, async ({ page, step, click, paste, expect, api, fixture }) => {
      // pool fixture: preview immediate, Browser Markdown takes 12 s; BROWSER_CONCURRENCY=2.
      const urls = Array.from({ length: 8 }, (_, i) => fixture("pool", `article-${i + 1}`));
      await step("Add 8 links at once (each takes ~12 s to render; only 2 render at a time)", "All 8 are saved and start processing");
      await click(page.getByRole("button", { name: "Add link" }));
      await paste(page.getByRole("textbox"), urls.join("\n"));
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect("8 links saved", async () => (await api.library()).links.length === 8, { timeout: 10_000 });
      const importedAt = Date.now();
      await expect.visible(page.getByText("Pooled article", { exact: false }).first(), "First previews appear in the list");

      await step("Wait past 30 s while the last links are still queued for a browser slot", "Nothing enters Needs attention; no 'failed' badge");
      await expect.holds("No link in Needs attention, no failure badge", 32_000, async () => {
        const lib = await api.library();
        if (lib.links.some((l) => l.attention_kind)) throw new Error(`attention on ${lib.links.filter((l) => l.attention_kind).map((l) => l.url).join(", ")}`);
        if (await attentionNav(page).isVisible()) throw new Error("Needs attention appeared in the sidebar");
        if (await page.getByText(/No preview|Context failed/).first().isVisible()) throw new Error("a failure badge is shown");
        return true;
      });
      await expect(`At ${Math.round((Date.now() - importedAt) / 1000)} s some links are still processing (queued > 30 s)`, async () => {
        const waiting = (await api.library()).links.filter((l) => l.processing);
        return Date.now() - importedAt >= 30_000 && waiting.length >= 1;
      }, { timeout: 2_000 });

      await step("Let the pool drain", "Every link ends with its preview and content; Needs attention never shows");
      await expect("All 8 links finished with content", async () => {
        const links = (await api.library()).links;
        return links.length === 8 && links.every((l) => !l.processing && l.status === "ready" && l.content_state === "ready");
      }, { timeout: 90_000 });
      await expect("No link needs attention", async () => (await api.library()).links.every((l) => l.attention_kind === null));
      await expect.hidden(attentionNav(page), "Sidebar shows no Needs attention entry");
      await expect.visible(page.getByText("Pooled article p1/article-8"), "The last queued link shows its real title");
    }),

    scenario("P2", "A fail-fast preview (404) lands in Needs attention with its plain reason", {
      ticket: "FAC-48",
      covers: "Fail-fast reasons skip retries; a final failure persists Needs attention with a plain reason and Retry / Dismiss.",
      expected: "Within seconds the link is in Needs attention: “Couldn't get the content: The page no longer exists.” with Retry and Dismiss. Dismiss removes it from the list.",
    }, async ({ page, step, click, type, expect, api, fixture }) => {
      const url = fixture("gone", "missing-page");
      await step("Add a link whose page answers HTTP 404", "Preview and content both fail fast with not_found");
      await click(page.getByRole("button", { name: "Add link" }));
      await type(page.getByRole("textbox"), url);
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect("API: link settled with content attention, reason not_found", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.attention_kind === "content" && l.attention_reason === "not_found" && l.preview_reason === "not_found";
      }, { timeout: 30_000 });
      await expect("API: one attempt each, no retries for a fail-fast reason", async () => {
        const jobs = await api.jobs(url);
        return jobs.length === 1 && jobs[0].status === "failed" && jobs[0].reason === "not_found";
      });

      await expect.visible(attentionNav(page), "UI: Needs attention appears in the sidebar");
      await step("Open Needs attention", "The link is listed with its plain reason, Retry and Dismiss");
      await click(attentionNav(page));
      const message = page.getByText("Couldn't get the content: The page no longer exists.");
      await expect.visible(message, "Plain reason shown on the row");
      const actions = message.locator("..");
      await expect.visible(actions.getByRole("button", { name: "Retry" }), "Retry is offered");
      await expect.visible(actions.getByRole("button", { name: "Dismiss" }), "Dismiss is offered");

      await step("Dismiss it", "It leaves Needs attention (until a later final failure)");
      await click(actions.getByRole("button", { name: "Dismiss" }));
      await expect("API: attention cleared", async () => (await api.link(url))?.attention_kind === null);
      await expect.hidden(attentionNav(page), "Needs attention entry is gone from the sidebar");
    }),
  ],
});
