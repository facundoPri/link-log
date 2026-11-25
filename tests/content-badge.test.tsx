import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserTab } from "@linklog/browser-protocol";
import { ContentBadge } from "../src/components/browser/TabMarkers";
import { accessOf } from "../src/components/browser/BrowserLensStatus";
import { TooltipProvider } from "../src/components/ui/tooltip";

// An extension build that speaks the same protocol version can still send a content state this
// app doesn't know (a build from another branch, or a future one). The row must not crash.
const tab = (content: string) =>
  ({ tabId: 1, tabInstanceId: "i1", documentRevision: 1, url: "https://example.com/", title: "T", content, sleep: null, load: null, capturedAt: null }) as unknown as BrowserTab;

describe("Browser tab content states from the extension", () => {
  for (const content of ["discarded", "frozen", undefined as unknown as string])
    test(`an unknown state (${content}) renders a generic badge instead of crashing`, () => {
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <ContentBadge tab={tab(content)} />
        </TooltipProvider>,
      );
      expect(html).toContain("Can&#x27;t read");
    });

  test("the inspector and lens cells get the same fallback, and known states keep their own label", () => {
    expect(accessOf("discarded" as BrowserTab["content"]).label).toBe("Can't read");
    expect(accessOf("sleeping").label).toBe("Sleeping");
  });
});
