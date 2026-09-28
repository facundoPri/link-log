import { BROWSER_LIMITS, type Capture, type PageFact } from "@linklog/browser-protocol";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Explicit "title and URL only" source, chosen by the user for pages that can't be read. */
export function metadataCapture(tab: { title?: string; url?: string }): Capture {
  const title = tab.title || tab.url || "";
  return {
    source: "metadata",
    capturedAt: new Date().toISOString(),
    completeness: "partial",
    reasons: ["Only the tab title and URL were used; the page content was not read."],
    chars: 0,
    facts: [],
    url: tab.url ?? "",
    title,
    description: "",
    siteName: "",
    markdown: `# ${title}\n\nURL: ${tab.url ?? ""}`,
  };
}

export class CaptureError extends Error {}

function explain(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (/Cannot access|permission|host/i.test(message)) return "Linklog doesn't have access to this site's content.";
  if (/gallery|cannot be scripted|chrome:\/\//i.test(message)) return "Chrome doesn't allow extensions to read this page.";
  if (/error page/i.test(message)) return "The page failed to load.";
  if (/No tab with id|Frame with ID/i.test(message)) return "The tab closed or navigated while it was being read.";
  return "The page could not be read.";
}

/** Reads the loaded DOM through the packaged extractor. The result is untrusted page data. */
export async function captureTab(tabId: number): Promise<Capture> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (max: number) =>
        (globalThis as { __linklogExtract?: (max: number) => unknown }).__linklogExtract?.(max),
      args: [BROWSER_LIMITS.maxCaptureChars],
    });
    const raw = injection?.result as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") throw new CaptureError("The page could not be read.");
    if (raw.ok !== true) throw new CaptureError(str(raw.reason, 300) || "The page could not be read.");
    const markdown = str(raw.markdown, BROWSER_LIMITS.maxCaptureChars);
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.slice(0, 20).map((r) => str(r, 300)) : [];
    const facts: PageFact[] = Array.isArray(raw.facts)
      ? raw.facts.slice(0, 20).flatMap((f) =>
          f && typeof f === "object"
            ? [{ key: str((f as PageFact).key, 60), label: str((f as PageFact).label, 80), value: str((f as PageFact).value, 200) }]
            : [],
        )
      : [];
    return {
      source: "dom",
      capturedAt: new Date().toISOString(),
      completeness: raw.completeness === "complete" ? "complete" : "partial",
      reasons,
      chars: markdown.length,
      facts,
      url: str(raw.url, 4096),
      title: str(raw.title, 1000),
      description: str(raw.description, 2000),
      siteName: str(raw.siteName, 200),
      image: /^https?:\/\//.test(str(raw.image, 2000)) ? str(raw.image, 2000) : "",
      byline: str(raw.byline, 200),
      lang: str(raw.lang, 20),
      extractor: raw.extractor === "article" ? "article" : "page",
      markdown,
    };
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(explain(error));
  }
}

/** Reads only the page's metadata (description, site name, preview image). */
export async function previewTab(tabId: number): Promise<{ description: string; siteName: string; image: string }> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as { __linklogPreview?: () => unknown }).__linklogPreview?.(),
  });
  const raw = (injection?.result ?? {}) as Record<string, unknown>;
  const image = str(raw.image, 2000);
  return {
    description: str(raw.description, 400),
    siteName: str(raw.siteName, 200),
    image: /^https?:\/\//.test(image) ? image : "",
  };
}
