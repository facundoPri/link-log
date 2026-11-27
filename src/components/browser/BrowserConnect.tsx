import { CircleAlert, Download, Globe, Lock, PlugZap, RefreshCw } from "lucide-react";
import type { BrowserWorkspace } from "../../browser/useBrowserWorkspace";
import { useQuery } from "@tanstack/react-query";
import { EXPECTED_EXTENSION_VERSION, extensionDownloadUrl, extensionReleaseUrl, type ExtensionUpdate } from "../../browser/extensionVersion";
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

/** The expected version's release page, or /latest once GitHub says that release doesn't exist. */
function useExtensionDownloadUrl(): string {
  const { data } = useQuery({
    queryKey: ["extension-download", EXPECTED_EXTENSION_VERSION],
    queryFn: () => extensionDownloadUrl(EXPECTED_EXTENSION_VERSION),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return data ?? extensionReleaseUrl(EXPECTED_EXTENSION_VERSION);
}

export function UpdateBanner({ update }: { update: ExtensionUpdate }) {
  const href = useExtensionDownloadUrl();
  return (
    <Banner
      icon={<Download className="size-3.5" />}
      action={
        <Button size="sm" variant="outline" className="h-7" asChild>
          <a href={href} target="_blank" rel="noreferrer">
            Download update
          </a>
        </Button>
      }
    >
      Linklog extension {update.installed} is older than this Linklog expects ({update.expected}). Unzip the new release over its
      folder and click ↻ in chrome://extensions.
    </Banner>
  );
}

function DownloadLink() {
  return (
    <a className="font-medium underline underline-offset-2" href={useExtensionDownloadUrl()} target="_blank" rel="noreferrer">
      Download extension {EXPECTED_EXTENSION_VERSION}
    </a>
  );
}

export function Connect({ ws }: { ws: BrowserWorkspace }) {
  const { connection, backendError, retry, installedVersion } = ws.browser;
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
        : connection === "consent"
          ? {
              icon: <Lock className="size-5" />,
              title: "Not connected yet",
              body: "The Linklog extension reads nothing until you accept on its Connect page. Accept there and Linklog connects on its own.",
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
                title: "Update the Linklog extension",
                body: `${installedVersion ? `The installed extension (${installedVersion})` : "The installed extension"} can't talk to this version of Linklog. Browser view needs extension ${EXPECTED_EXTENSION_VERSION}.`,
                steps: [
                  <><DownloadLink /> (the .zip under Assets).</>,
                  <>Unzip it over the folder you loaded the extension from.</>,
                  <>
                    Open <Kbd>chrome://extensions</Kbd> and click ↻ on the Linklog card.
                  </>,
                  <>Reload this page.</>,
                ],
                dev: "rebuild it with",
              }
            : {
                icon: <PlugZap className="size-5" />,
                title: "Connect the Linklog extension",
                body: "Browser view shows the tabs and groups of this Chrome window. It needs the Linklog extension.",
                steps: [
                  <><DownloadLink /> and unzip it into a folder you'll keep.</>,
                  <>
                    Open <Kbd>chrome://extensions</Kbd> and turn on Developer mode.
                  </>,
                  <>Click Load unpacked and choose the unzipped folder.</>,
                  <>Come back here — Linklog connects on its own.</>,
                ],
                dev: "build it with",
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
        {"dev" in content && (
          <p className="text-xs text-muted-foreground">
            Working on Linklog? Instead, {content.dev} <Kbd>bun run extension:build</Kbd> and load <Kbd>apps/extension/dist</Kbd>.
          </p>
        )}
        {connection === "reload" ? (
          <Button size="sm" onClick={() => location.reload()}>
            Reload page
          </Button>
        ) : connection === "consent" ? (
          <Button size="sm" onClick={() => void ws.browser.request("openPermissions", {}).catch(() => {})}>
            Open Connect page
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

