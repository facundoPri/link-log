// Injected on demand into a tab's main frame (isolated world). It only reads the
// DOM that is already loaded: no cookies, storage, form values or scripts, and no
// scrolling, clicking or reloading to "complete" the page. It has no access to the
// extension's privileged commands; its return value is untrusted data.

type Fact = { key: string; label: string; value: string };
type Extracted = {
  ok: true;
  url: string;
  title: string;
  description: string;
  siteName: string;
  markdown: string;
  completeness: "complete" | "partial";
  reasons: string[];
  facts: Fact[];
};
type Unavailable = { ok: false; reason: string };

const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "FRAME", "OBJECT",
  "EMBED", "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "HEAD", "META", "LINK", "VIDEO", "AUDIO",
]);
const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "LI", "UL", "OL",
  "TABLE", "TR", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "DL", "DT", "DD",
  "H1", "H2", "H3", "H4", "H5", "H6", "BR", "HR",
]);

function meta(name: string): string {
  const el = document.querySelector<HTMLMetaElement>(
    `meta[name="${name}"],meta[property="${name}"]`,
  );
  return (el?.content ?? "").trim().slice(0, 2000);
}

function hidden(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return true;
  const style = el instanceof HTMLElement ? getComputedStyle(el) : null;
  return !!style && (style.display === "none" || style.visibility === "hidden");
}

/** Evidence specific to application pages that article extractors would discard. */
function pageFacts(): Fact[] {
  const facts: Fact[] = [];
  const add = (key: string, label: string, value: string | null | undefined) => {
    const v = value?.replace(/\s+/g, " ").trim();
    if (v && facts.length < 20) facts.push({ key, label, value: v.slice(0, 200) });
  };
  const host = location.hostname;
  if (host === "github.com" && /^\/[^/]+\/[^/]+\/(pull|issues)\/\d+/.test(location.pathname)) {
    const kind = location.pathname.includes("/pull/") ? "Pull request" : "Issue";
    const state =
      document.querySelector("[data-testid='header-state']")?.textContent ??
      document.querySelector(".gh-header-meta .State, .State")?.getAttribute("title")?.replace(/^Status:\s*/, "") ??
      document.querySelector(".gh-header-meta .State, .State")?.textContent;
    add("github.state", `${kind} state`, state);
    add("github.title", `${kind} title`, document.querySelector(".js-issue-title, [data-testid='issue-title'], bdi.markdown-title")?.textContent);
    const comments = document.querySelectorAll(".timeline-comment, [data-testid='comment-viewer-outer-box']").length;
    if (comments) add("github.comments", "Comments loaded", String(comments));
    const checks = document.querySelector(".merge-status-list, [data-testid='mergebox-partial']")?.textContent;
    add("github.checks", "Merge box", checks?.slice(0, 200));
  }
  const published = meta("article:published_time");
  add("published", "Published", published);
  return facts;
}

function extract(maxChars: number): Extracted | Unavailable {
  const type = document.contentType || "text/html";
  if (type === "application/pdf" || document.querySelector("embed[type='application/pdf']"))
    return { ok: false, reason: "PDF content can't be read from the viewer." };
  if (!/html|xml|text\/plain/.test(type))
    return { ok: false, reason: `This tab shows ${type}, which can't be read as text.` };
  const reasons: string[] = [];
  const root =
    document.querySelector("main, [role='main']") ??
    (document.querySelectorAll("article").length === 1 ? document.querySelector("article") : null) ??
    document.body;
  if (!root) return { ok: false, reason: "The page has no content yet." };
  const lines: string[] = [];
  let line = "";
  const links = new Map<string, string>();
  const flush = () => {
    const t = line.replace(/[ \t ]+/g, " ").trim();
    if (t) lines.push(t);
    line = "";
  };
  let frames = 0;
  let elements = 0;
  const walk = (node: Node, depth: number) => {
    if (depth > 60 || elements > 25_000) return;
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    elements++;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") frames++;
    if (SKIP.has(el.tagName) || hidden(el)) return;
    // Editable regions may hold what the user is typing; never read them.
    if ((el as HTMLElement).isContentEditable) return;
    const block = BLOCK.has(el.tagName);
    if (block) flush();
    const heading = /^H([1-6])$/.exec(el.tagName);
    if (heading) line += "#".repeat(Number(heading[1])) + " ";
    if (el.tagName === "LI") line += "- ";
    if (el.tagName === "A") {
      const href = (el as HTMLAnchorElement).href;
      const label = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (/^https?:/.test(href) && label && links.size < 60 && !links.has(href)) links.set(href, label.slice(0, 120));
    }
    for (const child of el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes) walk(child, depth + 1);
    if (block) flush();
  };
  walk(root, 0);
  flush();
  // Collapse repeated empty/duplicate lines produced by layout wrappers.
  const text = lines.filter((l, i) => l !== lines[i - 1]).join("\n\n");
  const facts = pageFacts();
  const heading = `# ${document.title || location.href}`;
  const parts = text.startsWith(heading) ? [] : [heading, ""];
  if (facts.length) parts.push("## Page facts", "", ...facts.map((f) => `- ${f.label}: ${f.value}`), "");
  parts.push(text);
  if (links.size)
    parts.push("", "## Links on the page", "", ...[...links].slice(0, 40).map(([href, label]) => `- [${label}](${href})`));
  let markdown = parts.join("\n").trim();
  if (elements > 25_000) reasons.push("The page is very large; reading stopped after 25,000 elements.");
  if (frames) reasons.push(`${frames} embedded frame${frames === 1 ? " was" : "s were"} not read.`);
  if (text.length < 200)
    reasons.push("Very little text was loaded; the page may render content lazily or need you to open it.");
  reasons.push("Only content already loaded in the tab was read (scrolled-away or virtualized parts may be missing).");
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
    reasons.push(`Trimmed to ${maxChars.toLocaleString("en")} characters.`);
  }
  return {
    ok: true,
    url: location.href,
    title: document.title,
    description: meta("description") || meta("og:description"),
    siteName: meta("og:site_name"),
    markdown,
    // The "loaded content only" note is provenance, not a defect; other reasons make it partial.
    completeness: reasons.length > 1 ? "partial" : "complete",
    reasons,
    facts,
  };
}

(globalThis as { __linklogExtract?: typeof extract }).__linklogExtract = extract;
