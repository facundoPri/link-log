import { afterEach, expect, spyOn, test } from "bun:test";
import { extractMetadata } from "../worker/metadata";
import { enrich } from "../worker/routes/shared";
import { TestD1 } from "./support/d1";
const original = "https://www.youtube.com/watch?v=2jBTKgobGWw";
const mocks: { mockRestore(): void }[] = [];
afterEach(() => { for (const m of mocks.splice(0)) m.mockRestore(); });
function blocked() {
  mocks.push(spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    const url = String(input);
    if (url.includes("cloudflare-dns.com")) return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (url === original) return new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index?continue=video" } });
    return new Response("Blocked", { status: 429, headers: { "content-type": "text/html" } });
  }) as typeof fetch));
}
test("a blocked YouTube redirect never becomes the saved URL", async () => {
  blocked();
  const result = await extractMetadata(original);
  expect(result.url).toBe(original);
  expect(result.domain).toBe("youtube.com");
  expect(result.status).toBe("failed");
});
test("failed preview refresh preserves an existing title and thumbnail", async () => {
  blocked();
  const db = await TestD1.migrated();
  db.sqlite.exec(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Test','test@example.test',1,'t','t');`);
  db.sqlite.query("INSERT INTO links(id,user_id,original_url,url,domain,title,image,created_at,status) VALUES('link','owner',?,?,'youtube.com','Real video title','https://i.ytimg.com/vi/2jBTKgobGWw/hqdefault.jpg','t','ready')").run(original, original);
  await enrich(db.d1, "owner", "link", original);
  expect(db.sqlite.query("SELECT url,title,image FROM links WHERE id='link'").get()).toEqual({ url: original, title: "Real video title", image: "https://i.ytimg.com/vi/2jBTKgobGWw/hqdefault.jpg" });
});

test("oEmbed supplies a video preview without fetching the watch page", async () => {
  const fetched: string[] = [];
  mocks.push(spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    const url = String(input); fetched.push(url);
    if (url.includes("cloudflare-dns.com")) return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (url.includes("/oembed?")) return Response.json({ type: "video", title: "Video &amp; title", thumbnail_url: "https://i.ytimg.com/vi/2jBTKgobGWw/hqdefault.jpg" });
    throw new Error("Watch page is blocked");
  }) as typeof fetch));
  expect(await extractMetadata(original)).toMatchObject({ url: original, title: "Video & title", image: "https://i.ytimg.com/vi/2jBTKgobGWw/hqdefault.jpg", status: "ready" });
  expect(fetched).not.toContain(original);
});

test("HTTP 200 consent pages are not saved as video metadata", async () => {
  let consentFetched = false;
  mocks.push(spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    const url = String(input);
    if (url.includes("cloudflare-dns.com")) return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (url.includes("/oembed?")) return new Response(null, { status: 404 });
    if (url === original) return new Response(null, { status: 302, headers: { location: "https://consent.youtube.com/m" } });
    consentFetched = true;
    return new Response("<title>Before you continue to YouTube</title>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch));
  expect(await extractMetadata(original)).toMatchObject({ url: original, status: "failed" });
  expect(consentFetched).toBe(false);
});

test("normal public redirects still resolve successfully", async () => {
  mocks.push(spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    const url = String(input);
    if (url.includes("cloudflare-dns.com")) return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (url === "https://example.com/short") return new Response(null, { status: 302, headers: { location: "https://example.org/article" } });
    return new Response('<title>Article</title><meta property="og:image" content="/preview.jpg">', { headers: { "content-type": "text/html" } });
  }) as typeof fetch));
  expect(await extractMetadata("https://example.com/short")).toMatchObject({ url: "https://example.org/article", title: "Article", image: "https://example.org/preview.jpg", status: "ready" });
});

test("extraction keeps the YouTube adapter and prior preview when metadata is blocked", async () => {
  const { makeEnv } = await import("./support/env");
  const { testSession } = await import("./support/auth.test-instance");
  const { addLinks } = await import("../worker/links");
  const { loadOwnedJob } = await import("../worker/workflow");
  const { extractHandler } = await import("../worker/handlers/extract");
  const { youtubeAdapter } = await import("../worker/adapters/youtube");
  const db = await TestD1.migrated();
  const { env, queued, r2 } = makeEnv(db);
  const user = await testSession(env, "extract@example.test");
  const [saved] = await addLinks(env, user.userId, [original]);
  if (!saved || "error" in saved) throw new Error("setup failed");
  db.sqlite.query("UPDATE links SET title='Video title',image='https://i.ytimg.com/preview.jpg',status='ready' WHERE id=?").run(saved.id);
  const loaded = await loadOwnedJob(db.d1, queued[0]!.id);
  blocked();
  const discover = spyOn(youtubeAdapter, "discover").mockImplementation(async (_env, url) => {
    expect(url).toBe(original);
    return { source: "youtube", title: "Video title", text: "", media: [], details: { type: "youtube-video", completeness: "unverified", issues: ["No public transcript is available"] } };
  });
  mocks.push(discover);
  const step = { do: async (...args: any[]) => args.at(-1)() };
  await extractHandler.run({ env, step: step as never, job: loaded.job, link: loaded.link!, config: {} });
  expect(discover).toHaveBeenCalledTimes(1);
  expect(db.sqlite.query("SELECT url,title,image,content_source,content_state FROM links WHERE id=?").get(saved.id)).toEqual({ url: original, title: "Video title", image: "https://i.ytimg.com/preview.jpg", content_source: "youtube", content_state: "partial" });
  expect([...r2.objects.values()][0]).toContain("Transcription not available");
});
