import { validateDestination } from "../metadata";
import { measured } from "../usage";
import { browserFailure, LinkFailure } from "../failures";
import type { ContentAdapter } from "./types";
export const webAdapter: ContentAdapter = {
  name: "web",
  matches: () => true,
  async extract(env, url, job, signal) {
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
          errors?: { code?: number; message?: string }[];
        };
        if (!response.ok || data.success === false)
          throw browserFailure(response.status, data.errors?.[0]);
        if (typeof data.result !== "string" || !data.result.trim())
          throw new LinkFailure("empty");
        // A login wall or block page is not the content: it is discarded (never stored) and not retried.
        const wall = detectLoginWall(data.result);
        if (wall) {
          console.log(JSON.stringify({ event: "login_wall_detected", link_id: job.link_id, job_id: job.id, adapter: "web", domain: new URL(url).hostname, pattern: wall.pattern, text_length: data.result.length }));
          throw new LinkFailure("login_wall", { technical: `Matched "${wall.pattern}" in ${data.result.length} characters` });
        }
        return { markdown: data.result, source: "web" };
      },
      signal,
    );
  },
};

// Only short pages are considered: a real article can mention signing in, captchas or access denied.
const WALL_MAX_CHARS = 1500;
// Checked in order; the label is what telemetry reports. Plain "sign in" also needs a password field.
const WALL_PATTERNS: [string, RegExp][] = [
  ["verify you are human", /\bverify(ing)? (that )?you('re| are) (a )?human\b/],
  ["just a moment", /^just a moment\b|\bjust a moment(\.\.\.|…)/],
  ["captcha", /\b(re|h)?captcha\b/],
  ["access denied", /\baccess (is )?denied\b/],
  ["log in to continue", /\b(log ?in|sign ?in) to continue\b/],
  ["sign in required", /\b(log ?in|sign ?in) (is )?required\b|\b(log ?in|sign ?in) to (view|see|read|access)\b|\byou (must|need to) (be logged in|be signed in|log ?in|sign ?in)\b|\bplease (log ?in|sign ?in)\b/],
  ["unusual traffic", /\bunusual traffic\b/],
  ["not a robot", /\b(not a robot|are you a robot|robot or human)\b/],
  ["blocked", /\byou (have been|are|were) blocked\b|\bpardon our interruption\b|\battention required\b|\brequest (was )?blocked\b/],
  ["enable javascript", /\benable (javascript|cookies)( and (javascript|cookies))? to continue\b/],
];
const SIGN_IN = /\b(sign ?in|log ?in)\b/;
// A login form asks for a password; a navigation bar's "Sign in · Sign up" does not.
const CREDENTIALS = /\bpassword\b/;

/** A short extracted text that is a login wall, captcha or block page instead of the page's content. */
export function detectLoginWall(markdown: string): { pattern: string } | null {
  const text = markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_>`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (text.length > WALL_MAX_CHARS) return null;
  const found = WALL_PATTERNS.find(([, re]) => re.test(text));
  if (found) return { pattern: found[0] };
  return SIGN_IN.test(text) && CREDENTIALS.test(text) ? { pattern: "sign in" } : null;
}
