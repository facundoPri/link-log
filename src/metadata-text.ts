/** Provider text only: URL/domain defaults and adapter labels are not evidence. */
export function realTitle(title: string | null | undefined, domain?: string, url?: string): string {
  const value = title?.trim() ?? "";
  if (!value || /^(?:https?:\/\/|www\.)/i.test(value) || /^(?:youtube(?: video| post)?|instagram(?: post| reel)?|x post|twitter post)$/i.test(value)) return "";
  const normalized = value.toLowerCase().replace(/^www\./, "").replace(/\/$/, "");
  if (domain && normalized === domain.toLowerCase().replace(/^www\./, "")) return "";
  if (url) { try { if (normalized === new URL(url).hostname.replace(/^www\./, "")) return ""; } catch {} }
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i.test(value)) return "";
  return value;
}
export function metadataText(link: { title?: string | null; description?: string | null; domain?: string; url?: string; title_source?: string }) {
  return [link.title_source === "placeholder" ? "" : realTitle(link.title, link.domain, link.url), link.description?.trim() ?? ""].filter(Boolean).join("\n\n");
}
