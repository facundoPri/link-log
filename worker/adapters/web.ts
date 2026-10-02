import { validateDestination } from "../metadata";
import { measured } from "../usage";
import { browserFailure, LinkFailure } from "../failures";
import type { ContentAdapter } from "./types";
export const webAdapter: ContentAdapter = {
  name: "web",
  matches: () => true,
  async extract(env, url, job) {
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
        // A JSON envelope from the Browser API, never the page itself: no HTML content-type check here.
        const data = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          result?: string;
          errors?: { message: string }[];
        };
        if (!response.ok || data.success === false)
          throw browserFailure(response.status, data.errors?.[0]?.message);
        if (typeof data.result !== "string" || !data.result.trim())
          throw new LinkFailure("empty");
        return { markdown: data.result, source: "web" };
      },
    );
  },
};
