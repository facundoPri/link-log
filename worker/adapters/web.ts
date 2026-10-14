import { validateDestination } from "../metadata";
import { measured } from "../usage";
import type { ContentAdapter } from "./types";
import { requireBrowserRun } from "./browser-run";
import { accessInterstitial, accessPageTitle, mercadoLoginText, ACCESS_PAGE_ERROR } from "../access-page";
export const webAdapter: ContentAdapter = {
  matches: () => true,
  async extract(env, url, job) {
    requireBrowserRun(env);
    if (accessInterstitial(new URL(url))) throw new Error(ACCESS_PAGE_ERROR);
    await validateDestination(new URL(url), AbortSignal.timeout(10000));
    return measured(
      env,
      job,
      "browser-markdown",
      "cloudflare",
      "extract",
      async (meter) => {
        const response = await env.BROWSER.quickAction("markdown", { url });
        const used = response.headers.get("x-browser-ms-used");
        if (used !== null && Number.isFinite(Number(used)))
          meter.browser_ms = Number(used);
        const data = (await response.json()) as {
          success?: boolean;
          result?: string;
          errors?: { message: string }[];
          meta?: { finalUrl?: string; status?: number; title?: string };
        };
        if (!response.ok || data.success === false)
          throw new Error(
            data.errors?.[0]?.message || `Markdown: HTTP ${response.status}`,
          );
        if (typeof data.result !== "string" || !data.result.trim())
          throw new Error(
            "The page returned no content. You can paste it manually.",
          );
        // HTTP 200 from Browser means the rendering succeeded, not that the target
        // page was accessible. Check the origin response before publishing to R2.
        if ((data.meta?.finalUrl && accessInterstitial(new URL(data.meta.finalUrl))) ||
          accessPageTitle(data.meta?.title || "") || mercadoLoginText(data.result))
          throw new Error(ACCESS_PAGE_ERROR);
        if (data.meta?.status && data.meta.status >= 400)
          throw new Error(`The site returned HTTP ${data.meta.status}. Any saved preview and text were kept.`);
        return { markdown: data.result, source: "web" };
      },
    );
  },
};
