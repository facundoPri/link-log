export function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text || text.length > 4096 || /\s/.test(text))
    throw new Error("Paste a valid URL.");
  const url = new URL(
    /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`,
  );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname.includes(".")
  )
    throw new Error("Use a public http or https link.");
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  return url.href;
}
export function domainOf(input: string): string {
  const hostname = new URL(input).hostname.replace(/^www\./, "");
  return ["youtu.be", "m.youtube.com", "music.youtube.com"].includes(hostname)
    ? "youtube.com"
    : hostname;
}
export function pastedUrl(text: string): string | null {
  if (!/^https?:\/\/\S+$/i.test(text.trim())) return null;
  try {
    return normalizeUrl(text);
  } catch {
    return null;
  }
}

export function pastedUrls(text: string): string[] {
  const values = text.trim().split(/\s+/).filter(Boolean);
  if (!values.length || values.some((v) => !pastedUrl(v))) return [];
  return [...new Set(values.map((v) => normalizeUrl(v)))];
}
