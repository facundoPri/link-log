import { toast } from "sonner";
import type { Link } from "../types";

export async function copyLinks(links: Link[], withTitles: boolean) {
  const text = links
    .map((link) => (withTitles && link.title ? `${link.url} — ${link.title}` : link.url))
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${links.length} ${links.length === 1 ? "link" : "links"} copied`);
  } catch {
    toast.error("Could not copy links");
  }
}
