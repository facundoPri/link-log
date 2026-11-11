// session-run-window (FAC-181 review S1): a run's progress toast settles even when its batch leaves the
// library's 30-batch window. The journey starts a slow extraction from the selection, then saves 30 links
// through the API, so 30 newer batches push the run's batch out of the window before it finishes.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const url = fixture("held-yes", "window");

  await step("Set up: a saved link whose extraction takes 10 s");
  await api.send("POST", "/links", { url });
  const link = await check("API: the link is ready", async () => {
    const l = await api.link(url);
    return l && !l.processing && l.content_state === "ready" && l;
  }, { timeout: 60_000 });
  await page.reload();

  await step("Extract it again from the selection");
  await page.getByRole("checkbox", { name: `Select ${link.title}` }).first().click();
  await page.keyboard.press("e");
  await page.getByRole("alertdialog", { name: "Extract context for 1 link?" }).getByRole("button", { name: "Extract", exact: true }).click();
  const toast = page.locator("[data-sonner-toast]", { hasText: "Extracting context for 1 link" });
  await check("Toast: the run is in progress", () => toast.isVisible());
  const run = await check("API: the extraction batch is running", async () => {
    for (const b of (await api.library()).batches.filter((x: { kind: string; active: number }) => x.kind === "extract" && x.active > 0)) {
      const { jobs } = await api.get(`/batches/${b.id}`);
      if (jobs.some((j: { link_id: string }) => j.link_id === link.id)) return b;
    }
  });
  await shot("01-run-in-progress");

  await step("Save 30 links through the API while the run is in flight");
  await Promise.all(Array.from({ length: 30 }, (_, i) => api.send("POST", "/links", { url: fixture("article", `window-${i}`) })));
  await check("API: the run's batch is no longer in the library's window", async () => !(await api.library()).batches.some((b: { id: string }) => b.id === run.id));

  await step("The run finishes on the server");
  await check("API: every job of the run's batch finished", async () => {
    const { jobs } = await api.get(`/batches/${run.id}`);
    return jobs.every((j: { status: string }) => !["queued", "running", "waiting"].includes(j.status));
  }, { timeout: 60_000 });

  await step("The toast settles");
  await check("Toast: no longer shows the run in progress", async () => !(await toast.isVisible()), { timeout: 20_000 });
  await shot("02-run-settled");
}) satisfies Journey;
