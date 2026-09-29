import { CircleAlert, Globe, PlugZap, RefreshCw } from "lucide-react";
import type { BrowserWorkspace } from "../../browser/useBrowserWorkspace";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";

export function Banner({ icon, children, action }: { icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b bg-warning-soft/60 px-4 py-2 text-xs">
      <span className="text-amber-700 dark:text-amber-400">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export function Connect({ ws }: { ws: BrowserWorkspace }) {
  const { connection, backendError, retry } = ws.browser;
  // Connected (or reconnecting) without a snapshot yet — e.g. right after the page moved
  // to another window — is loading, not a missing extension.
  if ((connection === "checking" || connection === "connected" || connection === "reconnecting") && !backendError)
    return (
      <div className="divide-y">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-8" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  const content =
    backendError && !ws.browser.catalog
      ? {
          icon: <CircleAlert className="size-5" />,
          title: "The local API is unavailable",
          body: `${backendError} Start it with bun run dev.`,
          steps: null,
        }
      : connection === "unsupported"
        ? {
            icon: <Globe className="size-5" />,
            title: "Browser view needs desktop Chrome",
            body: "It reads tabs through the Linklog extension, which runs in Chrome or another Chromium browser on desktop.",
            steps: null,
          }
        : connection === "reload"
          ? {
              icon: <RefreshCw className="size-5" />,
              title: "The extension was updated",
              body: "Reload this page to reconnect. Results cached before the extension reloaded are gone; Linklog evaluates again only what you turn on.",
              steps: null,
            }
          : connection === "outdated"
            ? {
                icon: <CircleAlert className="size-5" />,
                title: "The extension is out of date",
                body: "Rebuild it with bun run extension:build, then reload it in chrome://extensions.",
                steps: null,
              }
            : {
                icon: <PlugZap className="size-5" />,
                title: "Connect the Linklog extension",
                body: "Browser view shows the tabs and groups of this Chrome window. It needs the Linklog extension.",
                steps: [
                  <>
                    Build it: <Kbd>bun run extension:build</Kbd>
                  </>,
                  <>
                    Open <Kbd>chrome://extensions</Kbd> and turn on Developer mode.
                  </>,
                  <>
                    Click Load unpacked and choose <Kbd>apps/extension/dist</Kbd>.
                  </>,
                  <>Come back here — Linklog connects on its own.</>,
                ],
              };
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">{content.icon}</div>
        <h2 className="text-sm font-medium">{content.title}</h2>
        <p className="text-[13px] text-muted-foreground">{content.body}</p>
        {content.steps && (
          <ol className="mt-2 w-full space-y-1.5 rounded-lg border bg-card p-3 text-left text-[13px]">
            {content.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium tabular">{i + 1}</span>
                <span className="min-w-0">{s}</span>
              </li>
            ))}
          </ol>
        )}
        {connection === "reload" ? (
          <Button size="sm" onClick={() => location.reload()}>
            Reload page
          </Button>
        ) : (
          connection !== "unsupported" && (
            <Button variant="ghost" size="sm" onClick={retry}>
              Try again
            </Button>
          )
        )}
      </div>
    </div>
  );
}

