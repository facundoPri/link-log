// Injected on demand into a tab's main frame (isolated world). It only reads the
// DOM that is already loaded: no cookies, storage, form values or scripts, and no
// scrolling, clicking or reloading to "complete" the page. It has no access to the
// extension's privileged commands; its return value is untrusted data.
//
// Pipeline, all local: sanitized copy of the visible DOM → Readability when the page
// is an article → Turndown (+ GFM tables) → Markdown. Application pages that are not
// articles (a PR, a dashboard) keep their main region instead of a guessed "article".
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

type Fact = { key: string; label: string; value: string };
type Extracted = {
  ok: true;
  url: string;
  title: string;
  description: string;
  siteName: string;
  image: string;
  byline: string;
  lang: string;
  extractor: "article" | "page";
  markdown: string;
  completeness: "complete" | "partial";
  reasons: string[];
  facts: Fact[];
};
type Unavailable = { ok: false; reason: string };
export type Preview = { description: string; siteName: string; image: string };

// Never copied: executable/embedded content and anything that can hold what the user types.
const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CANVAS", "IFRAME", "FRAME", "OBJECT", "EMBED",
  "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "HEAD", "META", "LINK", "VIDEO", "AUDIO", "FORM", "DIALOG",
]);
// Page chrome dropped when the whole page (not an article) is converted.
const CHROME = "nav, [role='navigation'], [role='banner'], [role='contentinfo'], [role='search'], [role='complementary'], [aria-label='Breadcrumb'], footer, aside";
const MAX_ELEMENTS = 25_000;
const MAX_DEPTH = 80;

function meta(...names: string[]): string {
  for (const name of names) {
    const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"],meta[property="${name}"]`);
    const v = (el?.content ?? "").trim();
    if (v) return v.slice(0, 2000);
  }
  return "";
}

function absolute(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url, document.baseURI);
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

/** Title, description and image from the page's own metadata; cheap enough for every tab. */
function preview(): Preview {
  const icon = document.querySelector<HTMLLinkElement>("link[rel='image_src']")?.href;
  return {
    description: meta("description", "og:description", "twitter:description").slice(0, 400),
    siteName: meta("og:site_name", "application-name").slice(0, 200),
    image: absolute(meta("og:image", "og:image:url", "twitter:image", "twitter:image:src") || icon).slice(0, 2000),
  };
}

function hidden(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return true;
  const style = el instanceof HTMLElement ? getComputedStyle(el) : null;
  return !!style && (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden");
}

/** Evidence specific to application pages that article extractors would discard. */
function pageFacts(byline: string, published: string): Fact[] {
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
  add("byline", "Author", byline);
  add("published", "Published", published);
  return facts;
}

/**
 * Copies the visible DOM into a detached document, walking original and copy side by
 * side so computed visibility (which a detached copy doesn't have) decides what stays.
 * Links and images get absolute URLs; open shadow roots are inlined.
 */
function sanitizedCopy() {
  const doc = document.implementation.createHTMLDocument(document.title);
  const base = doc.createElement("base");
  base.href = document.baseURI;
  doc.head.append(base);
  let elements = 0;
  let truncated = false;
  const copy = (node: Node, depth: number): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    if (el.namespaceURI === "http://www.w3.org/2000/svg") return null;
    if (SKIP.has(el.tagName) || (el as HTMLElement).isContentEditable || hidden(el)) return null;
    if (++elements > MAX_ELEMENTS || depth > MAX_DEPTH) {
      truncated = true;
      return null;
    }
    const out = doc.createElement(el.namespaceURI === "http://www.w3.org/1999/xhtml" ? el.tagName : "span");
    for (const name of ["role", "aria-label", "alt", "title", "colspan", "rowspan", "datetime", "lang", "id"]) {
      const v = el.getAttribute(name);
      if (v !== null) out.setAttribute(name, v.slice(0, 500));
    }
    // Readability and Turndown use class names for scoring and code languages.
    const cls = el.getAttribute("class");
    if (cls) out.setAttribute("class", cls.slice(0, 300));
    if (el instanceof HTMLAnchorElement) {
      const href = absolute(el.href);
      if (href) out.setAttribute("href", href);
    } else if (el instanceof HTMLImageElement) {
      const src = absolute(el.currentSrc || el.src);
      if (!src) return null;
      out.setAttribute("src", src);
    }
    const children = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : [...el.childNodes];
    for (const child of children) {
      const c = copy(child, depth + 1);
      if (c) out.append(c);
    }
    return out;
  };
  const body = document.body ? copy(document.body, 0) : null;
  if (body) doc.body.replaceWith(body);
  return { doc, elements, truncated };
}

function turndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  td.remove(["script", "style", "noscript"]);
  // Code blocks keep their language when the page declares one (class="language-ts").
  td.addRule("fencedLanguage", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const lang = /(?:language|lang|highlight-source)-([\w+#-]+)/.exec(
        `${el.className} ${el.querySelector("code")?.className ?? ""} ${el.parentElement?.className ?? ""}`,
      )?.[1];
      const text = (el.textContent ?? "").replace(/\n$/, "");
      const fence = text.includes("```") ? "~~~" : "```";
      return `\n\n${fence}${lang ?? ""}\n${text}\n${fence}\n\n`;
    },
  });
  // "- item" instead of Turndown's "-   item".
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1) || 1;
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });
  // Links without a usable target keep their text only.
  td.addRule("plainLinks", {
    filter: (node) => node.nodeName === "A" && !(node as HTMLElement).getAttribute("href"),
    replacement: (content) => content,
  });
  return td;
}

const textLength = (node: Node | null | undefined) => (node?.textContent ?? "").replace(/\s+/g, " ").trim().length;

function tidy(markdown: string) {
  return markdown
    .split("\n")
    .map((l) => l.replace(/[ \t ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(\s*-\s*)+$/gm, "")
    .trim();
}

function extract(maxChars: number): Extracted | Unavailable {
  const type = document.contentType || "text/html";
  if (type === "application/pdf" || document.querySelector("embed[type='application/pdf']"))
    return { ok: false, reason: "PDF content can't be read from the viewer." };
  if (!/html|xml|text\/plain/.test(type))
    return { ok: false, reason: `This tab shows ${type}, which can't be read as text.` };
  if (!document.body) return { ok: false, reason: "The page has no content yet." };
  const reasons: string[] = [];
  const { doc, truncated } = sanitizedCopy();
  const main =
    doc.querySelector("main, [role='main']") ??
    (doc.querySelectorAll("article").length === 1 ? doc.querySelector("article") : null) ??
    doc.body;
  const pageText = textLength(main);

  // Article pages: Readability picks the content and drops the site chrome. Only trust it
  // when it keeps most of the main region, so app pages (PR threads, lists) stay whole.
  let article: ReturnType<Readability<Node>["parse"]> = null;
  try {
    if (isProbablyReaderable(doc, { minContentLength: 200 }))
      article = new Readability<Node>(doc.cloneNode(true) as Document, {
        charThreshold: 300,
        keepClasses: true,
        serializer: (n) => n,
      }).parse();
  } catch {
    article = null;
  }
  const articleText = article?.textContent?.replace(/\s+/g, " ").trim().length ?? 0;
  const useArticle = !!article?.content && articleText >= 300 && articleText >= pageText * 0.4;
  let body: Node;
  if (useArticle) body = article!.content as Node;
  else {
    const region = main.cloneNode(true) as Element;
    // Keep chrome only when it's all there is.
    const stripped = region.cloneNode(true) as Element;
    stripped.querySelectorAll(CHROME).forEach((n) => n.remove());
    body = textLength(stripped) >= 200 ? stripped : region;
  }
  let text = "";
  try {
    text = tidy(turndown().turndown(body as HTMLElement));
  } catch {
    text = (body.textContent ?? "").replace(/\s+\n/g, "\n").trim();
  }

  const byline = (article?.byline || meta("author", "article:author")).slice(0, 200);
  const published = article?.publishedTime || meta("article:published_time", "datePublished");
  const facts = pageFacts(byline, published);
  const title = (useArticle && article?.title) || document.title || location.href;
  const parts = /^#\s/.test(text) ? [] : [`# ${title}`, ""];
  if (facts.length) parts.push("## Page facts", "", ...facts.map((f) => `- ${f.label}: ${f.value}`), "");
  parts.push(text);
  let markdown = parts.join("\n").trim();

  if (truncated) reasons.push(`The page is very large; reading stopped after ${MAX_ELEMENTS.toLocaleString("en")} elements.`);
  if (text.length < 200)
    reasons.push("Very little text was loaded; the page may render content lazily or need you to open it.");
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
    reasons.push(`Trimmed to ${maxChars.toLocaleString("en")} characters.`);
  }
  const defects = reasons.length;
  // Provenance, not a defect.
  reasons.push("Only content already loaded in the tab was read (scrolled-away or virtualized parts may be missing).");
  const p = preview();
  return {
    ok: true,
    url: location.href,
    title: document.title,
    description: p.description || (article?.excerpt ?? "").slice(0, 400),
    siteName: p.siteName || (article?.siteName ?? "").slice(0, 200),
    image: p.image,
    byline,
    lang: (article?.lang || document.documentElement.lang || "").slice(0, 20),
    extractor: useArticle ? "article" : "page",
    markdown,
    completeness: defects ? "partial" : "complete",
    reasons,
    facts,
  };
}

const g = globalThis as { __linklogExtract?: typeof extract };
g.__linklogExtract = extract;
