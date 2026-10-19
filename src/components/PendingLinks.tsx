import { PendingLinkRow } from "./LinkRow";

/** Same row layout as saved links; actions unlock after server confirmation. */
export function PendingLinks({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <div
      aria-label="Links being saved"
      className="divide-y border-b"
      aria-busy="true"
    >
      {urls.map((url) => (
        <PendingLinkRow key={url} url={url} />
      ))}
    </div>
  );
}
