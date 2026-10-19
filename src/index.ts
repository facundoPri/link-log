import { serve } from "bun";
import index from "./index.html";
import { apiPort, HOST, uiPort, uiUrl } from "../scripts/ports";
import { proxyApi } from "./proxy";

const server = serve({
  port: uiPort(),
  hostname: HOST,
  routes: {
    "/api/*": (request) => proxyApi(request as unknown as Request, apiPort()),
    "/*": index,
  },
  development: process.env.LINKLOG_NO_HMR ? false : { hmr: true, console: true },
});
// The canonical local origin is uiUrl() (cookies + Better Auth trusted origin);
// src/frontend.tsx moves localhost visits there.
console.log(`Linklog UI: ${uiUrl()} (bound to ${server.url})`);
