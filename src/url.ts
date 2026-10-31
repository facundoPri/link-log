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

/**
 * Every valid http(s) URL in free text, normalized, in order, without repeats. Text around a URL,
 * trailing punctuation and an unbalanced closing parenthesis (markdown, prose) are not part of it;
 * other schemes are ignored. A lone scheme-less token ("example.com") counts as a bare URL.
 * `reason` is the first URL rule broken by an http(s) URL in the text. A text with no such
 * candidate (prose, other schemes, a bare token that is not a URL) has no reason.
 * Cost is linear in the text length.
 */
export function scanUrls(text: string): { urls: string[]; reason?: string } {
  const found = new Set<string>();
  let reason: string | undefined;
  const add = (candidate: string, explain = true) => {
    try {
      found.add(normalizeUrl(candidate));
    } catch (error) {
      if (explain) reason ??= error instanceof Error && error.message ? error.message : "Invalid link.";
    }
  };
  const matches = text.match(/(?<![a-z\d+.-])https?:\/\/[^\s<>"[\]`]+/gi) ?? [];
  for (const match of matches) {
    // Count parentheses once and update the counts as characters are trimmed.
    let end = match.length;
    let open = 0;
    let close = 0;
    for (const ch of match) {
      if (ch === "(") open++;
      else if (ch === ")") close++;
    }
    while (end > 0) {
      const last = match[end - 1]!;
      const unbalanced = last === ")" && close > open;
      if (!unbalanced && !/[.,;:!?'*_]/.test(last)) break;
      if (last === ")") close--;
      end--;
    }
    add(match.slice(0, end));
  }
  if (!matches.length && /^[^\s<>"[\]`]+$/.test(text.trim())) add(text, false);
  return { urls: [...found], ...(reason && { reason }) };
}

export function pastedUrls(text: string): string[] {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const values = lines.flatMap((line) => {
    // Browser/bookmark lists and Linklog's own "Copy with titles" output.
    const item = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    const markdown = item.match(/^\[[^\]]*\]\((https?:\/\/\S+)\)$/i);
    if (markdown) return [markdown[1]!];
    const titled = item.match(/^(https?:\/\/\S+)\s+[—–]\s+.+$/i);
    if (titled) return [titled[1]!];
    return item
      .split(/\s+/)
      .map((value) => value.replace(/^<(https?:\/\/[^>]+)>$/i, "$1"));
  });
  if (!values.length || values.some((v) => !pastedUrl(v))) return [];
  return [...new Set(values.map((v) => normalizeUrl(v)))];
}

/** Prefer explicit URL lists/plain text; HTML is a fallback for selections copied from a page. */
export function clipboardUrls(data: Pick<DataTransfer, "getData">): string[] {
  const uriList = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const urls = pastedUrls(uriList);
  if (urls.length) return urls;
  const text = pastedUrls(data.getData("text/plain"));
  if (text.length) return text;
  const html = data.getData("text/html");
  if (!html) return [];
  // Parsing an inert document does not execute copied scripts or insert anything in the app.
  const template = document.createElement("template");
  template.innerHTML = html;
  const links = [...template.content.querySelectorAll("a[href]")].flatMap(
    (anchor) => {
      const url = pastedUrl(anchor.getAttribute("href") || "");
      return url ? [url] : [];
    },
  );
  return [...new Set(links)];
}
