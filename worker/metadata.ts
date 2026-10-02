import ipaddr from "ipaddr.js";
import { decodeHTML } from "entities";
import { normalizeUrl, domainOf } from "../src/url";
import { LinkFailure, responseFailure } from "./failures";
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
  const records = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const r = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal },
      );
      if (!r.ok) throw new Error("DNS unavailable");
      const body = (await r.json()) as {
        Answer?: { type: number; data: string }[];
      };
      return (body.Answer || [])
        .filter((a) => a.type === 1 || a.type === 28)
        .map((a) => a.data);
    }),
  );
  const addresses = records.flat();
  if (!addresses.length || addresses.some((a) => !publicAddress(a)))
    throw new Error("Not a public destination");
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
export async function extractMetadata(input: string) {
  const signal = AbortSignal.timeout(10000);
  let url = new URL(normalizeUrl(input));
  let response: Response | undefined;
  for (let n = 0; n < 6; n++) {
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
  return {
    status: "ready" as const,
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
