// Opens a Chromium-based browser with an isolated profile and the unpacked extension.
// Never uses your personal profile. Chrome stable ignores --load-extension, so this
// prefers Playwright's Chromium or Chrome for Testing (set CHROME_PATH to override).
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { uiUrl } from "./ports";

const root = resolve(import.meta.dir, "..");
const extension = resolve(root, "apps/extension/dist");
const profile = resolve(root, process.env.LINKLOG_CHROME_PROFILE ?? ".profiles/chrome-dev");

function executable(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH && resolve(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium"),
    "/opt/pw-browsers/chromium",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  try {
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    const path = chromium.executablePath();
    if (existsSync(path)) return path;
  } catch {}
  return null;
}

/** Chrome derives an unpacked extension's id from its absolute path. */
export function unpackedId(path: string) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

if (!existsSync(resolve(extension, "manifest.json"))) {
  console.log("Building the extension first…");
  const build = Bun.spawn(["bun", "apps/extension/scripts/build.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await build.exited) !== 0) process.exit(1);
}
const exe = executable();
if (!exe) {
  console.error(
    "No Chromium or Chrome for Testing found. Set CHROME_PATH, or load the extension by hand in Chrome:\n" +
      `  chrome://extensions → Developer mode → Load unpacked → ${extension}`,
  );
  process.exit(1);
}
await mkdir(profile, { recursive: true });
const version = (await new Response(Bun.spawn([exe, "--version"]).stdout).text()).trim();
const manifest = await Bun.file(resolve(extension, "manifest.json")).json();
const url = process.env.LINKLOG_URL ?? uiUrl();
const proc = Bun.spawn(
  [
    exe,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ],
  { stdout: "ignore", stderr: "ignore" },
);
proc.unref();
console.log(
  [
    `Browser:   ${version}`,
    `Binary:    ${exe}`,
    `Profile:   ${profile} (isolated, ignored by Git)`,
    `Extension: ${manifest.name} ${manifest.version} · id ${unpackedId(extension)}`,
    `           ${extension}`,
    `Bridge:    ${(manifest.content_scripts?.[0]?.matches ?? []).join(", ")}`,
    `Opening:   ${url}  (Browser view is in the sidebar)`,
    "",
    "Page content access is optional: grant it from the extension's Connect page or the Browser banner.",
  ].join("\n"),
);
