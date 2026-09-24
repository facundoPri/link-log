// Builds the unpacked extension into dist/. Flags: --watch, --package.
// LINKLOG_ORIGINS (or LINKLOG_UI_PORT / LINKLOG_API_PORT) decide which Linklog
// origins may use the bridge; they are written into the manifest and the bundle.
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { linklogOrigins } from "../../../scripts/ports";

const root = resolve(import.meta.dir, "..");
// LINKLOG_EXTENSION_OUT builds elsewhere (tests); LINKLOG_EXTRA_HOSTS grants test fixture hosts
// at install time. Neither is allowed in a packaged build.
const dist = process.env.LINKLOG_EXTENSION_OUT ? resolve(process.env.LINKLOG_EXTENSION_OUT) : join(root, "dist");
const extraHosts = (process.env.LINKLOG_EXTRA_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const pkg = await Bun.file(join(root, "package.json")).json();

export function manifest(origins: string[], version: string, extra: string[] = []) {
  const patterns = origins.map((o) => `${o}/*`);
  return {
    manifest_version: 3,
    name: "Linklog",
    version,
    description: "Connects Linklog's Browser view to the tabs and groups of its Chrome window.",
    minimum_chrome_version: "116",
    icons: { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
    action: { default_title: "Linklog", default_popup: "popup.html", default_icon: { "16": "icons/16.png", "32": "icons/32.png" } },
    background: { service_worker: "background.js", type: "module" },
    permissions: ["storage", "scripting", "tabGroups", "tabs"],
    // Only Linklog's own pages get the bridge. Reading other pages needs the
    // optional content access requested from connect.html.
    host_permissions: [...patterns, ...extra],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    content_scripts: [{ matches: patterns, js: ["bridge.js"], run_at: "document_start", all_frames: false }],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
}

// Tiny PNG encoder for the brand mark: green rounded square with a white link glyph.
function crc32(buf: Uint8Array) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function icon(size: number) {
  const px = new Uint8Array(size * (size * 4 + 1));
  const r = size * 0.22;
  const inside = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, r), size - r),
      cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // Two rounded "links" joined by a bar, like lucide's link-2.
  const glyph = (x: number, y: number) => {
    const u = x / size,
      v = y / size,
      t = 0.075;
    const ring = (cx: number) => {
      const d = Math.hypot((u - cx) * 1.35, v - 0.5);
      return Math.abs(d - 0.17) < t / 1.4 && Math.abs(u - 0.5) > 0.1;
    };
    const bar = Math.abs(v - 0.5) < t / 1.6 && u > 0.36 && u < 0.64;
    return ring(0.33) || ring(0.67) || bar;
  };
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      let hits = 0,
        white = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
        if (inside(x + dx, y + dy)) {
          hits++;
          if (glyph(x + dx, y + dy)) white++;
        }
      }
      const g = [0x1e, 0x8a, 0x62];
      const mix = white / Math.max(hits, 1);
      px[i] = Math.round(g[0]! + (255 - g[0]!) * mix);
      px[i + 1] = Math.round(g[1]! + (255 - g[1]!) * mix);
      px[i + 2] = Math.round(g[2]! + (255 - g[2]!) * mix);
      px[i + 3] = Math.round((hits / 4) * 255);
    }
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(px)),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

async function build() {
  const started = performance.now();
  const origins = linklogOrigins();
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, "icons"), { recursive: true });
  const define = {
    __LINKLOG_ORIGINS__: JSON.stringify(origins),
    __EXTENSION_VERSION__: JSON.stringify(pkg.version),
    "process.env.NODE_ENV": '"production"',
  };
  const jobs = [
    { entry: "src/background/index.ts", out: "background", format: "esm" as const },
    { entry: "src/bridge/index.ts", out: "bridge", format: "iife" as const },
    { entry: "src/extract/index.ts", out: "extract", format: "iife" as const },
    { entry: "src/pages/connect.ts", out: "connect", format: "iife" as const },
    { entry: "src/pages/popup.ts", out: "popup", format: "iife" as const },
  ];
  for (const job of jobs) {
    const result = await Bun.build({
      entrypoints: [join(root, job.entry)],
      target: "browser",
      format: job.format,
      minify: false,
      sourcemap: "none",
      define,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Build failed: ${job.entry}`);
    }
    await Bun.write(join(dist, `${job.out}.js`), await result.outputs[0]!.text());
  }
  for (const file of ["connect.html", "popup.html", "ui.css"]) await cp(join(root, "src/pages", file), join(dist, file));
  for (const size of [16, 32, 48, 128]) await Bun.write(join(dist, "icons", `${size}.png`), icon(size));
  await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest(origins, pkg.version, extraHosts), null, 2) + "\n");
  console.log(
    `Linklog extension ${pkg.version} → ${relative(process.cwd(), dist) || "dist"} (${Math.round(performance.now() - started)} ms)\n  bridge origins: ${origins.join(", ")}`,
  );
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out.sort();
}

async function zip() {
  // Only the built extension: no sources, tests, profiles, fixtures or env files.
  if (extraHosts.length || process.env.LINKLOG_EXTENSION_OUT)
    throw new Error("Test builds (LINKLOG_EXTRA_HOSTS / LINKLOG_EXTENSION_OUT) can't be packaged.");
  const out = join(root, `linklog-extension-${pkg.version}.zip`);
  await rm(out, { force: true });
  const list = (await files(dist)).map((f) => relative(dist, f));
  const forbidden = list.filter((f) => /(^|\/)(\.env|\.dev\.vars|.*\.map|tests?\/|fixtures?\/)/.test(f));
  if (forbidden.length) throw new Error(`Refusing to package: ${forbidden.join(", ")}`);
  const proc = Bun.spawn(["zip", "-X", "-q", "-r", out, ...list], { cwd: dist, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("zip failed");
  console.log(`Packaged ${relative(process.cwd(), out)} (${(await stat(out)).size} bytes, ${list.length} files)`);
}

if (import.meta.main) {
  await build();
  if (process.argv.includes("--package")) await zip();
  if (process.argv.includes("--watch")) {
    console.log(
      "Watching for changes. After each rebuild, click ↻ on the Linklog card in chrome://extensions.\n" +
        "Reloading the extension starts a new browser session: cached lens results are dropped (reloading the Linklog page keeps them).",
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    for (const dir of [join(root, "src"), resolve(root, "../../packages/browser-protocol/src")])
      watch(dir, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void build().catch((e) => console.error(e.message)), 150);
      });
    await new Promise(() => {});
  }
}

