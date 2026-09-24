import type { GroupColor } from "@linklog/browser-protocol";

/** Chrome's tab group palette, tuned to Linklog's tag family (same lightness). */
export const GROUP_STYLE: Record<GroupColor, { dot: string; bg: string; fg: string; label: string }> = {
  grey: { dot: "oklch(0.62 0.01 260)", bg: "oklch(0.95 0.004 260)", fg: "oklch(0.4 0.01 260)", label: "Grey" },
  blue: { dot: "oklch(0.62 0.16 255)", bg: "oklch(0.95 0.03 255)", fg: "oklch(0.42 0.13 255)", label: "Blue" },
  red: { dot: "oklch(0.63 0.2 25)", bg: "oklch(0.95 0.03 25)", fg: "oklch(0.45 0.15 25)", label: "Red" },
  yellow: { dot: "oklch(0.78 0.15 85)", bg: "oklch(0.96 0.05 90)", fg: "oklch(0.45 0.1 80)", label: "Yellow" },
  green: { dot: "oklch(0.65 0.15 150)", bg: "oklch(0.95 0.03 150)", fg: "oklch(0.4 0.1 150)", label: "Green" },
  pink: { dot: "oklch(0.68 0.18 350)", bg: "oklch(0.95 0.03 350)", fg: "oklch(0.45 0.14 350)", label: "Pink" },
  purple: { dot: "oklch(0.6 0.18 300)", bg: "oklch(0.95 0.035 300)", fg: "oklch(0.42 0.14 300)", label: "Purple" },
  cyan: { dot: "oklch(0.7 0.12 210)", bg: "oklch(0.95 0.03 210)", fg: "oklch(0.42 0.09 210)", label: "Cyan" },
  orange: { dot: "oklch(0.7 0.16 55)", bg: "oklch(0.95 0.04 60)", fg: "oklch(0.45 0.12 55)", label: "Orange" },
};

export function groupTitle(title: string) {
  return title.trim() || "Unnamed group";
}
