import type { CSSProperties } from "react";
import type { Evaluation, Link, Tag } from "../types";

export function tagHue(name: string): number {
  return [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 8;
}

export function tagStyle(name: string): CSSProperties {
  const n = tagHue(name);
  return {
    "--tag-bg": `var(--tag-${n}-bg)`,
    "--tag-fg": `var(--tag-${n}-fg)`,
    "--tag-dot": `var(--tag-${n}-dot)`,
  } as CSSProperties;
}

export function confidence(link: Link, tagId: string): Evaluation | undefined {
  return link.evaluations.find((e) => e.tag_id === tagId);
}

export function isStale(
  evaluation: Evaluation,
  tag: Tag,
  link: Link,
): boolean {
  return (
    evaluation.tag_version !== tag.version ||
    evaluation.content_version !== link.content_version
  );
}

export function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}
