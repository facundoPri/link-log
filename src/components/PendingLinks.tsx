import { Loader2 } from "lucide-react";

/** Pending saves are not library rows: no selection, extraction or delete actions until confirmed. */
export function PendingLinks({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <div aria-label="Links being saved" className="divide-y border-b" aria-busy="true">
      {urls.map((url) => (
        <div key={url} className="flex items-center gap-3 px-4 py-3 text-sm">
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate">{url}</p>
            <p className="text-xs text-muted-foreground">Saving…</p>
          </div>
        </div>
      ))}
    </div>
  );
}
