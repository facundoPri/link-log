export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? "https://linklog.facundopri.com";
export const REPO_URL = "https://github.com/facundoPri/link-log";
export const RELEASES_URL = `${REPO_URL}/releases`;

export const NAV = [
  { href: "#features", label: "Features" },
  { href: "#demo", label: "Demo" },
  { href: "#faq", label: "FAQ" },
] as const;
