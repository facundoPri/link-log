import extensionPackage from "../../apps/extension/package.json" with { type: "json" };

/** The extension version built from the same commit as this page; CI publishes it as a release. */
export const EXPECTED_EXTENSION_VERSION: string = extensionPackage.version;

const RELEASES = "https://github.com/facundoPri/link-log/releases";
export const LATEST_EXTENSION_URL = `${RELEASES}/latest`;
export const extensionReleaseUrl = (version: string) => `${RELEASES}/tag/extension-v${version}`;

/**
 * The release page of the version this page expects. Web deploys and extension releases run
 * separately, so /latest can be another version (a failed release, a rolled-back web): it is the
 * fallback only when GitHub answers that the expected release doesn't exist.
 */
export async function extensionDownloadUrl(
  expected: string,
  fetchRelease: (url: string) => Promise<Pick<Response, "status">> = fetch,
): Promise<string> {
  try {
    const res = await fetchRelease(`https://api.github.com/repos/facundoPri/link-log/releases/tags/extension-v${expected}`);
    if (res.status === 404) return LATEST_EXTENSION_URL;
  } catch {}
  return extensionReleaseUrl(expected);
}

export type ExtensionUpdate = { installed: string; expected: string };

/** x.y.z as Chrome loads it: each part 0–65535, no leading zeros. */
export function parseVersion(version: unknown): number[] | null {
  if (typeof version !== "string" || !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(version)) return null;
  const parts = version.split(".").map(Number);
  return parts.every((p) => p <= 65535) ? parts : null;
}

/** True only when both versions parse and `installed` is strictly older; anything unreadable is not "older". */
export function isOlderVersion(installed: unknown, expected: string): boolean {
  const a = parseVersion(installed);
  const b = parseVersion(expected);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export function extensionUpdate(installed: unknown, expected = EXPECTED_EXTENSION_VERSION): ExtensionUpdate | null {
  return isOlderVersion(installed, expected) ? { installed: installed as string, expected } : null;
}
