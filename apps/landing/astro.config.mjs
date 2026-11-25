// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// The canonical URL of the landing page. Override when it is served from another host.
const site = process.env.LANDING_SITE ?? "https://linklog.facundopri.com";

export default defineConfig({
  site,
  build: { inlineStylesheets: "auto" },
  vite: { plugins: [tailwindcss()] },
});
