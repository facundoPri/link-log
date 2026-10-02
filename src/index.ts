import { serve } from "bun";
import index from "./index.html";
import { proxyApi } from "./proxy";

const uiPort = Number(process.env.LINKLOG_UI_PORT || 3000);
const apiPort = Number(process.env.LINKLOG_API_PORT || 8787);

const server = serve({
  port: uiPort,
  hostname: "127.0.0.1",
  routes: {
    "/api/*": (request) => proxyApi(request as unknown as Request, apiPort),
    "/*": index,
  },
  development: { hmr: true, console: true },
});
// The canonical local origin is localhost:<port> (cookies + Better Auth trusted origin);
// src/frontend.tsx moves 127.0.0.1 visits there.
console.log(`Linklog UI: http://localhost:${uiPort} (bound to ${server.url})`);
