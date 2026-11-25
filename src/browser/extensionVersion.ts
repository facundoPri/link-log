import extensionPackage from "../../apps/extension/package.json" with { type: "json" };

/** The extension version built from the same commit as this page; CI publishes it as a release. */
export const EXPECTED_EXTENSION_VERSION: string = extensionPackage.version;

export const LATEST_EXTENSION_URL = "https://github.com/facundoPri/link-log/releases/latest";

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
