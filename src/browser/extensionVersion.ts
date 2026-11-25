import extensionPackage from "../../apps/extension/package.json" with { type: "json" };

/** The extension version built from the same commit as this page; CI publishes it as a release. */
export const EXPECTED_EXTENSION_VERSION: string = extensionPackage.version;

export const EXTENSION_RELEASES_URL = "https://github.com/facundoPri/link-log/releases";
export const LATEST_EXTENSION_URL = `${EXTENSION_RELEASES_URL}/latest`;

export type ExtensionUpdate = { installed: string; expected: string };

function parse(version: unknown): number[] | null {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return version.split(".").map(Number);
}

/** True only when both versions parse and `installed` is strictly older; anything unreadable is not "older". */
export function isOlderVersion(installed: unknown, expected: string): boolean {
  const a = parse(installed);
  const b = parse(expected);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export function extensionUpdate(installed: unknown, expected = EXPECTED_EXTENSION_VERSION): ExtensionUpdate | null {
  return isOlderVersion(installed, expected) ? { installed: installed as string, expected } : null;
}
