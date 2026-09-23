import { domainOf, normalizeUrl } from "../url";

export type RelatedLink = { url: string; domain: string; label: string };

const assetHost = /^(?:cards\.twitter\.com|pbs\.twimg\.com|video\.twimg\.com|scontent\.[\w.-]*|yt3\.ggpht\.com)$/i;
const assetPath = /\.(?:avif|gif|jpe?g|png|svg|webp|mp4|webm)(?:$|[?#])/i;

function candidate(raw: string, source: string): string | null {
  try {
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    const url = normalizeUrl(/^(?:\/|\.\/|\.\.\/)/.test(trimmed) ? new URL(trimmed, source).href : trimmed);
    const parsed = new URL(url);
    if (assetHost.test(parsed.hostname) || assetPath.test(parsed.pathname)) return null;
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname) && /\/status\/\d+\/(?:photo|video)\/\d+/.test(parsed.pathname)) return null;
    if (url.replace(/#.*$/, "") === normalizeUrl(source).replace(/#.*$/, "")) return null;
    const original = new URL(source);
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname) && parsed.hostname === original.hostname && parsed.pathname === original.pathname) return null;
    return url;
  } catch { return null; }
}

export function relatedLinks(markdown: string, source: string): RelatedLink[] {
  const found = new Map<string, RelatedLink>();
  const imageRanges: { start: number; end: number }[] = [];
  const add = (raw: string, label = "") => {
    const url = candidate(raw, source);
    if (!url || found.has(url)) return;
    const domain = domainOf(url);
    found.set(url, { url, domain, label: label.trim() || domain });
  };

  // Preserve the author-provided link label when Markdown supplies one.
  const markdownLinks = /(!?)\[([^\]\n]*)\]\(((?:https?:\/\/|\/|\.\/|\.\.\/)[^\s)]+)(?:\s+"[^"]*")?\)/gi;
  for (const match of markdown.matchAll(markdownLinks)) {
    if (match[1]) {
      imageRanges.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }
    add(match[3]!, match[2]);
  }
  const bareUrls = /https?:\/\/[^\s<>"']+/gi;
  for (const match of markdown.matchAll(bareUrls)) {
    if (imageRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
    let raw = match[0];
    // Markdown closing punctuation often follows a bare URL.
    raw = raw.replace(/[),.;:!?]+$/, "");
    add(raw);
  }
  // X articles sometimes print a destination as github.com/name/project without a scheme.
  const domains = /\b((?:[a-z\d-]+\.)+(?:app|ai|blog|cash|cloud|com|co|dev|edu|fm|gg|gov|io|is|link|me|net|org|rs|sh|site|software|so|tech|tools|xyz)\b(?:\/[^\s<>()[\]{}"']*)?)/gi;
  for (const match of markdown.matchAll(domains)) {
    const before = markdown.slice(Math.max(0, match.index - 8), match.index);
    if (before.endsWith("@") || before.endsWith("://") || before.endsWith("/")) continue;
    add(`https://${match[1]!.replace(/[),.;:!?]+$/, "")}`);
  }
  return [...found.values()];
}
