import { rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

// dist/ is what Wrangler deploys: local demo account hints must never be inlined into it.
if (process.env.BUN_PUBLIC_LINKLOG_DEV_FIXTURES) {
  console.error("Refusing to build with BUN_PUBLIC_LINKLOG_DEV_FIXTURES set (local demo only).");
  process.exit(1);
}

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./src/index.html"],
  outdir: "dist",
  target: "browser",
  minify: true,
  sourcemap: "linked",
  plugins: [tailwind],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  env: "BUN_PUBLIC_*",
});

for (const log of result.logs) {
  console.log(log);
}

if (!result.success) {
  process.exit(1);
}
