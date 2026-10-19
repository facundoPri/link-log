import { validateDestination } from "../metadata";
import { measured } from "../usage";
import { browserFailure, LinkFailure, statusReason } from "../failures";
import type { ContentAdapter } from "./types";
import { requireBrowserRun } from "./browser-run";
import { accessInterstitial, accessPageTitle, mercadoLoginText } from "../access-page";
export const webAdapter: ContentAdapter = {
  name: "web",
  matches: () => true,
  async extract(env, url, job, signal) {
    requireBrowserRun(env);
    if (accessInterstitial(new URL(url))) throw new LinkFailure("login_wall");
    await validateDestination(new URL(url), AbortSignal.timeout(10000));
    return measured(
      env,
      job,
      "browser-markdown",
      "cloudflare",
      "extract",
      async (meter) => {
        // Bounded below the attempt budget (100 s): navigation plus the Markdown action.
        const response = await env.BROWSER.quickAction("markdown", { url, gotoOptions: { timeout: 45_000 }, actionTimeout: 30_000 });
        const used = response.headers.get("x-browser-ms-used");
        if (used !== null && Number.isFinite(Number(used)))
          meter.browser_ms = Number(used);
        // A JSON envelope from the Browser API, never the page itself: no HTML content-type check here.
        const data = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          result?: string;
          meta?: { finalUrl?: string; status?: number; title?: string };
          errors?: { code?: number; message?: string }[];
        };
        if (!response.ok || data.success === false)
          throw browserFailure(response.status, data.errors?.[0]);
        if (typeof data.result !== "string" || !data.result.trim())
          throw new LinkFailure("empty");
        // A login wall or block page is not the content: it is discarded (never stored) and not retried.
        if (data.meta?.finalUrl) await validateDestination(new URL(data.meta.finalUrl), AbortSignal.timeout(10000));
        const access = (data.meta?.finalUrl && accessInterstitial(new URL(data.meta.finalUrl))) || accessPageTitle(data.meta?.title || "") || mercadoLoginText(data.result);
        const wall = access ? { pattern: "access interstitial" } : detectLoginWall(data.result);
        if (wall) {
          console.log(JSON.stringify({ event: "login_wall_detected", link_id: job.link_id, job_id: job.id, adapter: "web", domain: new URL(url).hostname, pattern: wall.pattern, text_length: data.result.length }));
          throw new LinkFailure("login_wall", { technical: `Matched "${wall.pattern}" in ${data.result.length} characters` });
        }
        if (data.meta?.status && data.meta.status >= 400) throw new LinkFailure(statusReason(data.meta.status), { http_status: data.meta.status });
        return { markdown: data.result, source: "web", display: { title: data.meta?.title || data.result.match(/^#\s+(.+)$/m)?.[1], image: data.result.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/)?.[1] } };
      },
      signal,
    );
  },
};

// Only short pages are considered: a real article can mention signing in, captchas or access denied.
const WALL_MAX_CHARS = 1500;
// The page itself must present the wall: each pattern matches a whole Markdown line (a heading or a
// standalone instruction) from its start, never a phrase quoted inside a sentence. Checked in order; the
// label is what telemetry reports.
const WALL_LINES: [string, RegExp][] = [
  ["verify you are human", /^(please )?(verify(ing)?|confirm) (that )?you('re| are) (a )?human\b/],
  ["just a moment", /^just a moment( ?(\.\.\.|…))?$/],
  ["captcha", /^(please )?(complete|solve|enter|type|fill in|answer) (the |this )?(following |security |below )?(re|h)?captcha\b/],
  ["access denied", /^(error \d+ )?access (is )?denied[.!]?$/],
  ["log in to continue", /^(please )?(log ?in|sign ?in) to continue\b/],
  ["sign in required", /^(please )?(log ?in|sign ?in) (is )?required\b|^(please )?(log ?in|sign ?in) to (view|see|read|access)\b|^you (must|need to) (be logged in|be signed in|log ?in|sign ?in)\b/],
  ["unusual traffic", /^our systems have detected unusual traffic\b/],
  ["not a robot", /^(robot or human\??|are you a robot\??)$|^(please )?(confirm|verify) (that )?(you('re| are)|i'?m|i am) not a robot\b/],
  ["blocked", /^(sorry, )?(you have been|you are|you were) blocked[.!]?$|^(the )?request (was )?blocked[.!]?$|^pardon our interruption[.!]?$|^attention required!?( \| cloudflare)?$/],
  ["enable javascript", /^(please )?enable (javascript|cookies)( and (javascript|cookies))? to continue\b/],
];
// A plain "sign in" counts only on a sign-in form: a short sign-in line plus a standalone password field,
// or several "Sign in with …" provider buttons. A word in prose or a navigation link is not enough.
const SIGN_IN_LINE = /^(sign ?in|log ?in|login)\b.{0,30}$/;
const PASSWORD_FIELD = /^((enter )?(your )?password|forgot (your )?password\??)$/;
const PROVIDER_BUTTON = /^(sign ?in|log ?in|continue) with (google|apple|facebook|microsoft|github|email|phone)$/;

const plainLines = (markdown: string) => markdown.split("\n")
  .map((line) => line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase())
  .filter(Boolean);

/** A short extracted text that is a login wall, captcha or block page instead of the page's content. */
export function detectLoginWall(markdown: string): { pattern: string } | null {
  const lines = plainLines(markdown);
  if (lines.join(" ").length > WALL_MAX_CHARS) return null;
  const found = WALL_LINES.find(([, re]) => lines.some((line) => re.test(line)));
  if (found) return { pattern: found[0] };
  const form = lines.some((l) => PASSWORD_FIELD.test(l)) || lines.filter((l) => PROVIDER_BUTTON.test(l)).length >= 2;
  return form && lines.some((l) => SIGN_IN_LINE.test(l)) ? { pattern: "sign in" } : null;
}
