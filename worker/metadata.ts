import ipaddr from "ipaddr.js";
import { youtubeId } from "./adapters/youtube";
import { decodeHTML } from "entities";
import { normalizeUrl, domainOf } from "../src/url";
import { LinkFailure, responseFailure, classify } from "./failures";
import { realTitle } from "../src/metadata-text";
import { accessInterstitial, accessPageTitle } from "./access-page";
export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function validateDestination(url: URL, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("Unsupported port");
  if (ipaddr.isValid(host)) {
    if (!publicAddress(host)) throw new Error("Private address");
    return;
  }
  if (
    !host.includes(".") ||
    /\.(localhost|local|internal|test|invalid)$/i.test(host)
  )
    throw new Error("Private host");
  const records = await Promise.allSettled(
    ["A", "AAAA"].map(async (type) => {
      const r = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal },
      );
      if (!r.ok) throw new Error("DNS unavailable");
      const body = (await r.json()) as {
        Status?: number;
        Answer?: { type: number; data: string }[];
      };
      if (body.Status === 3) throw new LinkFailure("unreachable", { technical: "DNS NXDOMAIN", retryable: false });
      if (body.Status && body.Status !== 0) throw new LinkFailure("unreachable", { technical: `DNS resolver status ${body.Status}` });
      return (body.Answer || [])
        .filter((a) => a.type === 1 || a.type === 28)
        .map((a) => a.data);
    }),
  );
  // A definite refusal wins over temporary failures from the other record family.
  const refused = records.find(r => r.status === "rejected" && r.reason instanceof LinkFailure && !r.reason.retryable);
  if (refused?.status === "rejected") throw refused.reason;
  const addresses = records.flatMap(r => r.status === "fulfilled" ? r.value : []);
  if (addresses.some(a => !publicAddress(a))) throw new Error("Not a public destination");
  const failed = records.find(r => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (!addresses.length) throw new LinkFailure("unreachable", { technical: "DNS returned no address records" });
}
function safeAsset(raw: string | undefined, base: string) {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export type Metadata = { url: string; domain: string; title: string; description: string; image: string | null; favicon: string | null; status: "ready" | "failed"; error?: string; failure?: { reason: LinkFailure["reason"]; detail: LinkFailure["detail"] }; title_source?: "metadata" | "placeholder" };

function failedPreview(input: string, error = "Preview unavailable. Any previously saved metadata was kept."): Metadata {
  return { url: input, domain: domainOf(input), title: domainOf(input), description: "", image: null, favicon: null, status: "failed", error };
}

/** oEmbed is independent of watch-page/caption access; a missing transcript must not erase a preview. */
async function youtubePreview(input: string, videoId: string): Promise<Metadata | null> {
  try {
    const signal = AbortSignal.timeout(4000);
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    endpoint.searchParams.set("format", "json");
    await validateDestination(endpoint, signal);
    const response = await fetch(endpoint, { signal, redirect: "manual" });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64_000) return null;
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(data));
    if (body.type !== "video" || typeof body.title !== "string" || !body.title.trim()) return null;
    return { url: input, domain: "youtube.com", title: decodeHTML(body.title).trim().slice(0,500), description: "",
      image: safeAsset(typeof body.thumbnail_url === "string" ? body.thumbnail_url : undefined, input),
      favicon: "https://www.youtube.com/favicon.ico", status: "ready" };
  } catch { return null; }
}

export async function extractMetadata(input: string): Promise<Metadata> {
  const original = normalizeUrl(input);
  const videoId = youtubeId(original);
  if (videoId) {
    const preview = await youtubePreview(original, videoId);
    if (preview) return preview;
  }
  try { return await pageMetadata(original); }
  catch (error) { const failure = classify(error); return { ...failedPreview(original, failure.message), failure: { reason: failure.reason, detail: { ...failure.detail, retryable: failure.retryable } } }; }
}

async function pageMetadata(input: string): Promise<Metadata> {
  const signal = AbortSignal.timeout(10000);
  let url = new URL(input);
  let response: Response | undefined;
  for (let n = 0; n < 6; n++) {
    if (accessInterstitial(url)) throw new LinkFailure("login_wall", { technical: "Access interstitial redirect" });
    await validateDestination(url, signal);
    response = await fetch(url.href, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "Linklog/0.1 (link preview)",
        Accept: "text/html",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Missing destination");
      url = new URL(normalizeUrl(new URL(location, url).href));
      response = undefined;
      continue;
    }
    break;
  }
  if (!response) throw new LinkFailure("unknown", { technical: "Too many redirects", retryable: false });
  const failure = responseFailure(response);
  if (failure) {
    await response.body?.cancel();
    throw failure;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty page");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) break;
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  const meta: Record<string, string> = {};
  let title = "";
  let icon = "";
  await new HTMLRewriter()
    .on("title", {
      text(t) {
        title += t.text;
      },
    })
    .on("meta", {
      element(e) {
        const key = e.getAttribute("property") || e.getAttribute("name");
        const value = e.getAttribute("content");
        if (key && value) meta[key.toLowerCase()] = value;
      },
    })
    .on("link", {
      element(e) {
        if ((e.getAttribute("rel") || "").split(/\s+/).includes("icon"))
          icon = e.getAttribute("href") || "";
      },
    })
    .transform(new Response(data))
    .text();
  if (accessPageTitle(decodeHTML(title)) || accessPageTitle(decodeHTML(meta["og:title"] || "")))
    throw new LinkFailure("login_wall", { technical: "Access page title" });
  // YouTube sometimes returns only its app shell, with no video metadata.
  if (youtubeId(input) && !meta["og:title"] && !meta["twitter:title"] && /^\s*(?:-\s*)?YouTube\s*$/i.test(title))
    return failedPreview(input);
  return {
    status: "ready" as const,
    title_source: realTitle(meta["og:title"] || meta["twitter:title"] || title, domainOf(url.href), url.href) ? "metadata" : "placeholder",
    url: url.href,
    domain: domainOf(url.href),
    title: decodeHTML(
      meta["og:title"] || meta["twitter:title"] || title || domainOf(url.href),
    )
      .trim()
      .slice(0, 500),
    description: decodeHTML(
      meta["og:description"] || meta.description || "",
    ).slice(0, 1000),
    image: safeAsset(meta["og:image"] || meta["twitter:image"], url.href),
    favicon: safeAsset(icon || "/favicon.ico", url.href),
  };
}

/** A failed refresh changes status only; never replace useful metadata with an error page. */
export function metadataStatement(db: D1Database, userId: string, id: string, metadata: Metadata, guard = "1", params: unknown[] = []) {
  if (metadata.status === "failed") {
    return db.prepare(`UPDATE links SET preview_reason=CASE WHEN status='ready' THEN preview_reason ELSE ? END,status=CASE WHEN status='ready' OR original_metadata IS NOT NULL THEN 'ready' ELSE 'failed' END,metadata_error=? WHERE id=? AND user_id=? AND ${guard}`)
      .bind(metadata.failure?.reason ?? "unknown", metadata.error || "Preview unavailable. Any previously saved metadata was kept.", id, userId, ...params);
  }
  const title = realTitle(metadata.title, metadata.domain, metadata.url);
  const snapshot = title || metadata.image || metadata.description ? JSON.stringify({ ...metadata, captured_at: new Date().toISOString() }) : null;
  return db.prepare(`UPDATE links SET original_metadata=coalesce(original_metadata,?),metadata_error=NULL,url=?,domain=?,
    title=CASE WHEN ?<>'' THEN ? ELSE title END,title_source=CASE WHEN ?<>'' THEN 'metadata' ELSE title_source END,
    description=CASE WHEN trim(?)='' THEN description ELSE ? END,
    image=coalesce(?,image),favicon=coalesce(?,favicon),status='ready',preview_reason=NULL WHERE id=? AND user_id=? AND ${guard}`)
    .bind(snapshot, metadata.url, metadata.domain, title, title, title, metadata.description, metadata.description, metadata.image, metadata.favicon, id, userId, ...params);
}
export async function saveMetadata(db: D1Database, userId: string, id: string, metadata: Metadata) {
  await metadataStatement(db, userId, id, metadata).run();
}
