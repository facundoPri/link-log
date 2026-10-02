import { validateDestination } from "../metadata";
import { measured } from "../usage";
import { ADAPTER_MESSAGES } from "../failures";
import { allowedMediaHost, type MediaSource } from "../media-hosts";
import type { ContentAdapter, Discovered, ExtractionJob } from "./types";

const MAX_HTML = 3_000_000;
type RawMedia = Discovered["media"][number];

async function boundedText(response: Response, max = MAX_HTML): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The post returned no HTML.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("The post HTML exceeds the extraction limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(data);
}

async function publicHtml(url: string): Promise<string> {
  let current = new URL(url);
  const signal = AbortSignal.timeout(20_000);
  for (let i = 0; i < 5; i++) {
    await validateDestination(current, signal);
    const response = await fetch(current.href, {
      redirect: "manual", signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Linklog/0.1)", Accept: "text/html" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("The post redirected without a destination.");
      current = new URL(location, current);
      if (current.protocol !== "https:") throw new Error("Unsafe post redirect.");
      continue;
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel();
      throw new Error(`The public post is unavailable (HTTP ${response.status}).`);
    }
    return boundedText(response);
  }
  throw new Error("Too many post redirects.");
}

async function renderedHtml(env: Env, url: string, job: ExtractionJob): Promise<string> {
  await validateDestination(new URL(url), AbortSignal.timeout(10_000));
  return measured(env, job, "browser-content", "cloudflare", "discover", async (meter) => {
    const response = await env.BROWSER.quickAction("content", { url });
    const ms = Number(response.headers.get("x-browser-ms-used"));
    if (Number.isFinite(ms) && ms > 0) meter.browser_ms = ms;
    const data = await response.json() as { success?: boolean; result?: string; errors?: { message: string }[] };
    if (!response.ok || data.success === false || typeof data.result !== "string")
      throw new Error(data.errors?.[0]?.message || `Rendered post: HTTP ${response.status}`);
    if (data.result.length > MAX_HTML) throw new Error("Rendered post HTML exceeds the extraction limit.");
    return data.result;
  });
}

function imageUrl(raw: unknown, source: MediaSource): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && allowedMediaHost(url.hostname, source) ? url.href : null;
  } catch { return null; }
}

function scripts(html: string, type: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => new RegExp(`type=["']${type.replace("+", "\\+")}["']`, "i").test(m[1] || ""))
    .map((m) => m[2] || "");
}

export function parseYoutubePost(html: string, postId: string): Discovered {
  const canonical = `https://www.youtube.com/post/${postId}`;
  for (const raw of scripts(html, "application/ld+json")) {
    let item: Record<string, unknown>;
    try { item = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (item.url !== canonical || !String(item["@type"] || "").includes("DiscussionForumPosting")) continue;
    const images = Array.isArray(item.image) ? item.image : [];
    const media: RawMedia[] = images.flatMap((raw, index): RawMedia[] => {
      const url = imageUrl(raw, "youtube");
      return url ? [{ media_key: new URL(url).pathname, position: index, kind: "image", url: `${url}=s1600`, preview_url: `${url}=s800` }] : [];
    });
    const issues: string[] = [];
    if (media.length !== images.length) issues.push("Some post images had unsafe or missing URLs.");
    if (!Array.isArray(item.image)) issues.push("Image attachment metadata was unavailable.");
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) issues.push("The post text was unavailable.");
    return {
      source: "youtube-post", title: String(item.headline || "YouTube post"), text, media,
      details: { type: "youtube-post", completeness: issues.length ? "unverified" : "verified", issues },
    };
  }
  throw new Error(ADAPTER_MESSAGES.youtubePostMissing);
}

type AnyObject = Record<string, unknown>;
function isObject(value: unknown): value is AnyObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function findInstagram(value: unknown, code: string): AnyObject | null {
  if (isObject(value)) {
    if (value.code === code && Array.isArray(value.carousel_media)) return value;
    if (value.code === code && isObject(value.if_not_gated_logged_out)) {
      const inner = value.if_not_gated_logged_out;
      if (inner.code === code) return inner;
    }
    for (const child of Object.values(value)) {
      const found = findInstagram(child, code);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findInstagram(child, code);
      if (found) return found;
    }
  }
  return null;
}

function findCarouselCount(value: unknown, code: string): number | null {
  if (isObject(value)) {
    if (value.code === code && Number.isInteger(value.carousel_media_count) && Number(value.carousel_media_count) > 0)
      return Number(value.carousel_media_count);
    for (const child of Object.values(value)) {
      const count = findCarouselCount(child, code);
      if (count !== null) return count;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const count = findCarouselCount(child, code);
      if (count !== null) return count;
    }
  }
  return null;
}

function instagramImageUrl(item: AnyObject): string | null {
  const versions = isObject(item.image_versions2) ? item.image_versions2.candidates : null;
  const candidates = Array.isArray(versions) ? versions : [];
  const usable = candidates.flatMap((candidate): { url: string; area: number }[] => {
    if (!isObject(candidate)) return [];
    const url = imageUrl(candidate.url, "instagram");
    const width = Number(candidate.width);
    const height = Number(candidate.height);
    return url && width > 0 && height > 0 && Math.max(width, height) <= 2048
      ? [{ url, area: width * height }] : [];
  });
  usable.sort((a, b) => b.area - a.area);
  return usable[0]?.url || imageUrl(item.display_uri, "instagram");
}

export function parseInstagram(html: string, code: string, reel: boolean): Discovered {
  let post: AnyObject | null = null;
  let expected: number | null = null;
  for (const raw of scripts(html, "application/json")) {
    if (!raw.includes(`"code":"${code}"`)) continue;
    try {
      const data = JSON.parse(raw);
      post ||= findInstagram(data, code);
      expected ||= findCarouselCount(data, code);
    } catch { /* another script */ }
    if (post && expected !== null) break;
  }
  if (!post) throw new Error(ADAPTER_MESSAGES.instagramLogin);
  const children = Array.isArray(post.carousel_media) ? post.carousel_media : [post];
  const media: RawMedia[] = [];
  const issues: string[] = [];
  for (let i = 0; i < children.length; i++) {
    const item = children[i];
    if (!isObject(item)) { issues.push(`Attachment ${i + 1} is unavailable.`); continue; }
    const kind = item.media_type === 2 ? "video" : "image";
    const preview = imageUrl(item.display_uri, "instagram") || (kind === "image" ? instagramImageUrl(item) : null);
    if (!preview) { issues.push(`Attachment ${i + 1} has no safe preview.`); continue; }
    media.push({ media_key: String(item.pk || item.id || `${code}:${i}`), position: i, kind, url: kind === "image" ? instagramImageUrl(item) || preview : preview, preview_url: preview });
  }
  const caption = isObject(post.caption) ? post.caption.text : null;
  const text = typeof caption === "string" ? caption.trim() : "";
  if (Array.isArray(post.carousel_media) && expected === null) issues.push("Carousel attachment count could not be verified.");
  if (expected !== null && expected !== children.length) issues.push(`Expected ${expected} attachments; ${children.length} were listed.`);
  if (media.length !== children.length) issues.push(`${children.length} attachments were listed; ${media.length} had accessible previews.`);
  if (!text) issues.push("The post description was unavailable.");
  return {
    source: reel ? "instagram-reel" : "instagram-post",
    title: reel ? "Instagram reel" : "Instagram post", text, media,
    details: { type: reel ? "instagram-reel" : "instagram-post", completeness: issues.length ? "unverified" : "verified", issues },
  };
}

function jsString(source: string): string | null {
  const match = source.match(/^"(?:\\.|[^"\\])*"/s);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
function jsRecord(source: string, marker: string): string | null {
  const at = source.indexOf(marker);
  if (at < 1 || source[at - 1] !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = at - 1; i < source.length && i < at + 1_000_000; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(at, i);
  }
  return null;
}
function topLevelStringField(record: string, field: string): string | null {
  const source = `,${record}`;
  let objects = 0;
  let arrays = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "{") { objects++; continue; }
    if (ch === "}") { objects--; continue; }
    if (ch === "[") { arrays++; continue; }
    if (ch === "]") { arrays--; continue; }
    if (ch !== "," || objects !== 0 || arrays !== 0) continue;
    let at = i + 1;
    while (/\s/.test(source[at] || "")) at++;
    if (source.slice(at, at + field.length) !== field) continue;
    at += field.length;
    while (/\s/.test(source[at] || "")) at++;
    if (source[at] !== ":") continue;
    return jsString(source.slice(at + 1).trimStart());
  }
  return null;
}
function referencedRecord(html: string, start: string, fields: string[]): string | null {
  let id = start;
  for (const field of fields) {
    const record = jsRecord(html, `__id:"${id}"`);
    if (!record) return null;
    const ref = record.match(new RegExp(`${field}:\\$R\\[\\d+\\]=\\{__ref:"([^"]+)"`));
    if (!ref) return null;
    id = ref[1]!;
  }
  return jsRecord(html, `__id:"${id}"`);
}

function expandXUrls(html: string, prefixes: string[], text: string): string {
  for (const prefix of prefixes) {
    const marker = `__id:"${prefix}`;
    let at = 0;
    while ((at = html.indexOf(marker, at)) !== -1) {
      const record = jsRecord(html.slice(at - 1), marker);
      at += marker.length;
      if (!record) continue;
      const short = topLevelStringField(record, "url");
      const expanded = topLevelStringField(record, "expanded_url");
      if (!short || !expanded || !text.includes(short)) continue;
      try {
        const destination = new URL(expanded);
        if (!["https:", "http:"].includes(destination.protocol) || destination.username || destination.password) continue;
        text = text.replaceAll(short, `[${destination.hostname.replace(/^www\./, "")}](${destination.href})`);
      } catch { /* malformed URL entity */ }
    }
  }
  return text;
}
function articleLinks(html: string, articleId: string): string[] {
  const prefix = `__id:"client:${articleId}:content_state:entity_map:`;
  const urls = new Set<string>();
  let at = 0;
  while ((at = html.indexOf(prefix, at)) !== -1) {
    const record = jsRecord(html.slice(at - 1), prefix);
    at += prefix.length;
    if (!record?.startsWith(prefix) || !/^\d+:value:data"/.test(record.slice(prefix.length))) continue;
    const raw = topLevelStringField(record, "url");
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) urls.add(url.href);
    } catch { /* malformed article link */ }
  }
  return [...urls];
}
export function parseXPost(html: string, id: string): Discovered {
  const key = btoa(`Tweet:${id}`);
  const root = jsRecord(html, `__id:"${key}"`);
  const details = jsRecord(html, `__id:"client:${key}:details"`);
  if (!details) throw new Error(ADAPTER_MESSAGES.xPostMissing);
  let text = topLevelStringField(details, "full_text");
  if (text === null) throw new Error(ADAPTER_MESSAGES.xTextMissing);
  let title = "X post";
  const issues: string[] = [];
  const note = referencedRecord(html, `client:${key}:note_tweet`, ["note_tweet_results", "result"]);
  if (!note && root?.includes("note_tweet:$R")) issues.push("The long-form post text was unavailable.");
  if (note?.includes('__typename:"NoteTweet"')) {
    const full = topLevelStringField(note, "text");
    if (full) text = full;
    else issues.push("The long-form post text was unavailable.");
  }
  const article = referencedRecord(html, `client:${key}:article`, ["article_results", "result"]);
  if (!article && root?.includes("article:$R")) issues.push("The article body was unavailable.");
  if (article?.includes('__typename:"ArticleEntity"')) {
    const full = topLevelStringField(article, "plain_text");
    if (full) {
      text = full;
      title = topLevelStringField(article, "title") || title;
      const articleId = topLevelStringField(article, "id");
      const links = articleId ? articleLinks(html, articleId) : [];
      if (links.length) text += `\n\n## Links in article\n\n${links.map((url) => `- [${new URL(url).hostname}](${url})`).join("\n")}`;
    } else issues.push("The article body was unavailable.");
  }
  const noteId = note ? topLevelStringField(note, "id") : null;
  text = expandXUrls(html, [`client:${key}:url_entities:`, ...(noteId ? [`client:${noteId}:entity_set:urls:`] : [])], text);
  const list = root?.match(/media_entities2:\$R\[\d+\]=\{__refs:\$R\[\d+\]=\[([^\]]*)\]/);
  const expected = new Set<string>();
  for (const match of (list?.[1] || "").matchAll(new RegExp(`"client:${key.replace(/[+/=]/g, "\\$&")}:media_entities2:(\\d+)"`, "g"))) expected.add(match[1]!);
  const media: RawMedia[] = [];
  const seen = new Set<string>();
  if (!list) issues.push("The post's attachment list could not be verified.");
  const pattern = new RegExp(`__id:"client:${key.replace(/[+/=]/g, "\\$&")}:media_entities2:(\\d+)"`, "g");
  for (const match of html.matchAll(pattern)) {
    const mediaKey = match[1]!;
    if (seen.has(mediaKey)) continue;
    seen.add(mediaKey);
    if (list && !expected.has(mediaKey)) { issues.push(`Unlisted attachment ${mediaKey} was ignored.`); continue; }
    const block = jsRecord(html.slice(match.index! - 1), match[0]);
    if (!block) { issues.push(`Attachment ${mediaKey} could not be read.`); continue; }
    const urlAt = block.indexOf("media_url_https:");
    const raw = urlAt < 0 ? null : jsString(block.slice(urlAt + 16));
    const url = imageUrl(raw, "x");
    if (!url) { issues.push(`Attachment ${mediaKey} has no safe preview.`); continue; }
    const isVideo = /type:"(?:video|animated_gif)"/.test(block);
    media.push({ media_key: mediaKey, position: Number(mediaKey), kind: isVideo ? "video" : "image", url: isVideo ? url : url.replace(/\.(?:jpg|jpeg|png|webp)$/i, "?format=jpg&name=large"), preview_url: url });
  }
  for (const mediaKey of expected) if (!seen.has(mediaKey)) issues.push(`Attachment ${mediaKey} was listed but unavailable.`);
  return { source: "x-post", title, text, media: media.sort((a,b) => a.position-b.position), details: { type: "x-post", completeness: issues.length ? "unverified" : "verified", issues } };
}

async function discoverWithFallback(env: Env, url: string, job: ExtractionJob, parse: (html: string) => Discovered, retryWhen: (found: Discovered) => boolean = () => false): Promise<Discovered> {
  let first: Discovered | undefined;
  let firstError: unknown;
  try {
    first = parse(await publicHtml(url));
    if (!retryWhen(first)) return first;
  } catch (error) { firstError = error; }
  try {
    const rendered = parse(await renderedHtml(env, url, job));
    return first && rendered.text.length <= first.text.length && rendered.details.issues.length >= first.details.issues.length ? first : rendered;
  } catch (error) {
    if (first) return first;
    throw new Error(`${firstError instanceof Error ? firstError.message : "Public post unavailable"} Rendered retry: ${error instanceof Error ? error.message : "failed"}`);
  }
}

export const youtubePostAdapter: ContentAdapter = {
  name: "youtube-post",
  matches: (url) => /^https:\/\/(?:www\.|m\.)?youtube\.com\/post\/Ug[\w-]+/.test(url),
  async discover(env, url, job) {
    const id = new URL(url).pathname.split("/")[2];
    if (!id) throw new Error("Missing YouTube post ID.");
    return discoverWithFallback(env, url, job, (html) => parseYoutubePost(html, id));
  },
};
export const instagramAdapter: ContentAdapter = {
  name: "instagram",
  matches: (url) => /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+/.test(url),
  async discover(env, url, job) {
    const parsed = new URL(url);
    const code = parsed.pathname.split("/")[2];
    if (!code) throw new Error("Missing Instagram post ID.");
    parsed.searchParams.set("hl", "en");
    return discoverWithFallback(env, parsed.href, job, (html) => parseInstagram(html, code, parsed.pathname.startsWith("/reel/")));
  },
};
export const xAdapter: ContentAdapter = {
  name: "x",
  matches: (url) => /^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(url),
  async discover(env, url, job) {
    const id = new URL(url).pathname.match(/\/status\/(\d+)/)?.[1];
    if (!id) throw new Error("Missing X post ID.");
    return discoverWithFallback(env, url, job, (html) => parseXPost(html, id),
      (found) => found.details.issues.some((issue) => issue.includes("long-form post text") || issue.includes("article body")));
  },
};
