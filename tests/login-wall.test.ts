// FAC-57: a login wall, captcha or block page that the web adapter extracted "successfully" is discarded.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";
import { FAILURE_MESSAGES } from "../src/failures";
import { detectLoginWall } from "../worker/adapters/web";

let events: Record<string, unknown>[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  events = [];
  spy = spyOn(console, "log").mockImplementation((line: unknown) => {
    try { events.push(JSON.parse(String(line))); } catch { /* not JSON */ }
  });
});
afterEach(() => { spy.mockRestore(); resetClock(); });

type S = Awaited<ReturnType<typeof setup>>;
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const reextract = (s: S, id: string) => s.api("/batches", "POST", { kind: "extract", ids: [id] });
const lastJob = (s: S, id: string) => s.db.query("SELECT status,step,reason,error FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as Record<string, string>;
const linkRow = (s: S, id: string) => s.db.query("SELECT title,content_key,content_source,content_state,content_reason,attention_kind,attention_reason FROM links WHERE id=?").get(id) as Record<string, string | null>;
const markdown = (result: string) => () => new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { "content-type": "application/json" } });
// A public IP literal skips DNS in validateDestination, so the real web adapter runs offline.
const PUBLIC_URL = "https://93.184.216.34/members/article?token=secret";

// What Browser Rendering returns as Markdown for common walls and block pages.
const FIXTURES: [string, string, string][] = [
  ["Cloudflare challenge", "verify you are human", "# www.example.com\n\nVerifying you are human. This may take a few seconds.\n\nwww.example.com needs to review the security of your connection before proceeding.\n\nRay ID: 8c1f2e3d4a5b6c7d\n\nPerformance & security by [Cloudflare](https://www.cloudflare.com)"],
  ["Cloudflare interstitial", "just a moment", "Just a moment...\n\nEnable JavaScript and cookies to continue"],
  ["captcha", "captcha", "## Please complete the CAPTCHA below\n\nWe need to make sure you're not a bot.\n\n[Submit](https://example.com/submit)"],
  ["Akamai block", "access denied", "# Access Denied\n\nYou don't have permission to access \"http://www.example.com/\" on this server.\n\nReference #18.4a3c2e17.1727880000.1f2e3d4"],
  ["log in to continue", "log in to continue", "![logo](https://example.com/logo.png)\n\n## Log in to continue\n\nEmail address\n\nPassword\n\n[Forgot password?](https://example.com/reset)\n\nNew here? [Create an account](https://example.com/join)"],
  ["sign-in form", "sign in", "# Sign in\n\nEmail or phone\n\nPassword\n\n[Forgot your password?](https://example.com/forgot)\n\n[Sign in](https://example.com/login)\n\nDon't have an account? [Sign up](https://example.com/signup)"],
  ["sign in to view", "sign in required", "Instagram\n\nYou must be logged in to see this post.\n\n[Log in](https://www.instagram.com/accounts/login/) · [Sign up](https://www.instagram.com/accounts/emailsignup/)"],
  ["robot check", "not a robot", "# Robot or human?\n\nConfirm that you are not a robot by clicking the box below.\n\nPress & Hold"],
  ["unusual traffic", "unusual traffic", "Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot."],
  ["block page", "blocked", "# Sorry, you have been blocked\n\nYou are unable to access example.com\n\n## Why have I been blocked?\n\nThis website is using a security service to protect itself from online attacks."],
  ["JavaScript wall", "enable javascript", "# example.com\n\nPlease enable JavaScript and cookies to continue."],
  ["PerimeterX", "blocked", "# Pardon Our Interruption\n\nAs you were browsing something about your browser made us think you were a bot."],
];

const paragraph = "The city council approved the new transit plan on Tuesday after months of public hearings, with members citing ridership growth, shorter commutes and the cost of maintaining the existing bus fleet as the main reasons for the change. ";
const LONG_ARTICLE = `# Transit plan approved\n\n${paragraph.repeat(12)}\n\nReaders can sign in to save this article for later.\n\n${paragraph.repeat(8)}`;
const SHORT_POST = "# Release notes 2.4\n\nThis release improves startup time, fixes the export dialog on small screens and adds keyboard shortcuts for the editor. Thanks to everyone who reported issues.\n\n[Home](https://example.com) · [Docs](https://example.com/docs) · [Sign in](https://example.com/login) · [Sign up](https://example.com/join)";
const ARTICLE_ABOUT_CAPTCHAS = `# Why CAPTCHAs keep getting harder\n\n${"Researchers say the puzzles meant to verify you are human now trip up people more often than bots, and some sites show an access denied page to whole networks. ".repeat(14)}`;

for (const [name, pattern, text] of FIXTURES)
  test(`detects ${name} ("${pattern}")`, () => {
    expect(detectLoginWall(text)?.pattern).toBe(pattern);
  });

test("a long article that mentions sign in once, a short page with a Sign in link and a long article about captchas are not walls", () => {
  expect(LONG_ARTICLE.length).toBeGreaterThan(4000);
  expect(detectLoginWall(LONG_ARTICLE)).toBeNull();
  expect(detectLoginWall(SHORT_POST)).toBeNull();
  expect(detectLoginWall(ARTICLE_ABOUT_CAPTCHAS)).toBeNull();
});

for (const [name, pattern, text] of FIXTURES)
  test(`${name}: discarded without retry; with no content the link needs attention with login_wall and keeps its preview`, async () => {
    const s = await setup();
    fakes.browser = markdown(text);
    const id = await save(s, PUBLIC_URL);
    await s.runQueued();
    expect(fakes.calls.browser).toBe(1);
    expect(s.r2.size).toBe(0);
    expect(await s.view(id)).toMatchObject({
      status: "ready", content: "failed", attention: true, attention_kind: "content", attention_reason: "login_wall",
      content_reason: "login_wall", err: FAILURE_MESSAGES.login_wall,
    });
    expect(linkRow(s, id)).toMatchObject({ title: "Title of 93.184.216.34", content_key: null });
    expect(lastJob(s, id)).toMatchObject({ status: "failed", reason: "login_wall", error: FAILURE_MESSAGES.login_wall });
    const detected = events.filter((e) => e.event === "login_wall_detected");
    expect(detected).toEqual([{ event: "login_wall_detected", link_id: id, job_id: expect.any(String), adapter: "web", domain: "93.184.216.34", pattern, text_length: text.length }]);
    expect(JSON.stringify(events)).not.toContain("token=secret");
    expect(events.filter((e) => e.event === "link_step_failed")).toMatchObject([{ step: "content", reason: "login_wall", retryable: false, final: true, attempt: 1 }]);
  });

test("with previous content, a login wall keeps the previous version and is recorded only in Activity", async () => {
  const s = await setup();
  fakes.browser = markdown(LONG_ARTICLE);
  const id = await save(s, PUBLIC_URL);
  await s.runQueued();
  const before = linkRow(s, id);
  expect(before).toMatchObject({ content_state: "ready", content_source: "web" });
  expect(s.r2.get(before.content_key!)).toBe(LONG_ARTICLE);

  fakes.browser = markdown(FIXTURES[0]![2]);
  await reextract(s, id);
  await s.runQueued();
  expect(fakes.calls.browser).toBe(2);
  expect(linkRow(s, id)).toMatchObject({ content_key: before.content_key, content_state: "ready", attention_kind: null, title: before.title });
  expect([...s.r2.values()]).toEqual([LONG_ARTICLE]);
  expect(await s.view(id)).toMatchObject({ attention: false, content_reason: "login_wall" });
  expect(lastJob(s, id)).toMatchObject({ status: "failed", reason: "login_wall", error: FAILURE_MESSAGES.login_wall });
  expect(events.filter((e) => e.event === "login_wall_detected")).toHaveLength(1);
});

test("a long article that mentions sign in once is saved as content", async () => {
  const s = await setup();
  fakes.browser = markdown(LONG_ARTICLE);
  const id = await save(s, PUBLIC_URL);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", attention: false, content_reason: null });
  expect(events.filter((e) => e.event === "login_wall_detected")).toEqual([]);
});

test("with the preview fallback on, a login wall with no content gets the preview as content", async () => {
  const s = await setup();
  await s.api("/settings", "PUT", { preview_fallback: true });
  fakes.meta = { status: "ready", description: "What the page is about." };
  fakes.browser = markdown(FIXTURES[4]![2]);
  const id = await save(s, PUBLIC_URL);
  await s.runQueued();
  const link = linkRow(s, id);
  expect(link).toMatchObject({ content_source: "preview", content_state: "partial", content_reason: "login_wall", attention_kind: null });
  expect(s.r2.get(link.content_key!)).toBe("Title of 93.184.216.34\n\nWhat the page is about.");
  expect([...s.r2.values()].join()).not.toContain("Log in to continue");
  expect(lastJob(s, id)).toMatchObject({ status: "failed", step: "Used the preview", reason: "login_wall" });
});
