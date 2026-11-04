import { Loader2, Moon, Pause, Play, RotateCw, X } from "lucide-react";
import type { BrowserTab, LoadAction, LoadRunView } from "@linklog/browser-protocol";
import { plural } from "../../lib/format";
import { LOAD_NOTE, runActive } from "../../browser/sleeping";
import { Banner } from "./BrowserConnect";
import { Button } from "@/components/ui/button";

/**
 * Above the tab list: how many tabs of this view are sleeping and why lenses can't read
 * them, with Load content; during a run, its progress and controls.
 */
export function LoadContentBanner({
  sleeping,
  run,
  sleepingOnly,
  onLoad,
  onControl,
  onToggleFilter,
}: {
  /** Sleeping tabs of the current view (scope and filters) with nothing captured. */
  sleeping: BrowserTab[];
  run: LoadRunView | null;
  sleepingOnly: boolean;
  onLoad: () => void;
  onControl: (action: LoadAction) => void;
  onToggleFilter: () => void;
}) {
  const small = "h-7";
  if (runActive(run) || (run && (run.failed > 0 || run.pauseReason) && run.status !== "cancelled")) {
    const r = run!;
    const finished = r.done + r.failed + r.skipped;
    return (
      <Banner
        icon={r.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <Moon className="size-3.5" />}
        action={
          <div className="flex shrink-0 items-center gap-1">
            {r.status === "running" && (
              <Button size="sm" variant="outline" className={small} onClick={() => onControl("pause")}>
                <Pause className="size-3.5" />
                Pause
              </Button>
            )}
            {r.status === "paused" && (
              <Button size="sm" variant="outline" className={small} onClick={() => onControl("resume")}>
                <Play className="size-3.5" />
                Resume
              </Button>
            )}
            {r.failed > 0 && (
              <Button size="sm" variant="outline" className={small} onClick={() => onControl("retry")}>
                <RotateCw className="size-3.5" />
                Retry {r.failed} failed
              </Button>
            )}
            {runActive(r) && (
              <Button size="sm" variant="ghost" className={small} onClick={() => onControl("cancel")}>
                <X className="size-3.5" />
                Cancel
              </Button>
            )}
          </div>
        }
      >
        <span role="status" aria-label="Load content progress" data-load-run={r.status}>
          {r.status === "paused" ? "Loading paused" : r.status === "done" ? "Content loaded" : "Loading content"}
          {" · "}
          {r.awake} awake now · {finished} of {r.total} done
          {r.failed > 0 && ` · ${r.failed} couldn't load`}
          {r.skipped > 0 && ` · ${r.skipped} skipped`}
          {r.pauseReason && <span className="block text-muted-foreground">{r.pauseReason}</span>}
        </span>
      </Banner>
    );
  }
  if (!sleeping.length) return null;
  return (
    <Banner
      icon={<Moon className="size-3.5" />}
      action={
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" className={small} aria-pressed={sleepingOnly} onClick={onToggleFilter}>
            {sleepingOnly ? "Show all tabs" : "Show sleeping"}
          </Button>
          <Button size="sm" variant="outline" className={small} onClick={onLoad}>
            Load content
          </Button>
        </div>
      }
    >
      <span data-sleeping-count={sleeping.length}>
        {plural(sleeping.length, "tab")} in this view {sleeping.length === 1 ? "is" : "are"} sleeping. Chrome hasn't loaded{" "}
        {sleeping.length === 1 ? "it" : "them"}, so lenses can't read {sleeping.length === 1 ? "it" : "them"}.
        <span className="block text-muted-foreground">{LOAD_NOTE}</span>
      </span>
    </Banner>
  );
}
