import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LOAD_CONCURRENCY } from "@linklog/browser-protocol";
import { toast } from "sonner";
import { useBrowser } from "../../browser/useBrowser";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const CHOICES = Array.from({ length: LOAD_CONCURRENCY.max - LOAD_CONCURRENCY.min + 1 }, (_, i) => String(LOAD_CONCURRENCY.min + i));
const settingsKey = ["browser", "load-settings"] as const;

/** Settings' Browser row: how many tabs Load content keeps awake at once. The extension stores it, per browser. */
export function LoadSettings() {
  const browser = useBrowser();
  const client = useQueryClient();
  const ready = browser.connection === "connected" && !!browser.hello?.capabilities.includes("load-settings");
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => browser.request("loadSettings", {}), enabled: ready });
  const choose = async (value: string) => {
    if (!value) return;
    try {
      client.setQueryData(settingsKey, await browser.request("loadSettings", { concurrency: Number(value) }));
    } catch (e) {
      toast.error(`Couldn't save the setting: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div id="load-concurrency-label" className="text-sm font-medium">
          Tabs loaded at once
        </div>
        <p className="text-xs text-muted-foreground">
          {ready
            ? `Load content wakes this many sleeping tabs at a time in this browser. More is faster but uses more memory. Default ${LOAD_CONCURRENCY.default}.`
            : browser.connection === "checking"
              ? "Connecting to the Linklog extension…"
              : "Open Settings in Chrome with the Linklog extension installed to change this."}
        </p>
      </div>
      {ready && settings.data && (
        <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby="load-concurrency-label" value={String(settings.data.concurrency)} onValueChange={(v) => void choose(v)}>
          {CHOICES.map((n) => (
            <ToggleGroupItem key={n} value={n} aria-label={`${n} at once`} className="min-w-8 tabular-nums">
              {n}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
}
