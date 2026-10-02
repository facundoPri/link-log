import { validateDestination } from "../metadata";
import { measured } from "../usage";
import { LinkFailure } from "../failures";
import type { ContentAdapter } from "./types";
export const webAdapter: ContentAdapter = {
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
        const data = (await response.json()) as {
          success?: boolean;
          result?: string;
          errors?: { message: string }[];
        };
        if (!response.ok || data.success === false)
          throw new Error(
            data.errors?.[0]?.message || `Markdown: HTTP ${response.status}`,
          );
        if (typeof data.result !== "string" || !data.result.trim())
          throw new LinkFailure("empty");
        return { markdown: data.result, source: "web" };
      },
    );
  },
};
