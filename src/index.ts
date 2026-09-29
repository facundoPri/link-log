import { serve } from "bun";
import index from "./index.html";
import { apiPort, HOST, uiPort } from "../scripts/ports";
const server = serve({
  port: uiPort(),
  hostname: HOST,
  routes: {
    "/api/*": async (request) => {
      const url = new URL(request.url);
      url.hostname = HOST;
      url.port = String(apiPort());
      const headers = new Headers(request.headers);
      headers.delete("host");
      // Wrangler is bound to loopback; preserve same-origin checks at the browser boundary.
      const origin = headers.get("origin");
      if (origin && origin !== new URL(request.url).origin)
        return Response.json(
          { error: "Origin not allowed." },
          { status: 403 },
        );
      headers.delete("origin");
      try {
        const response = await fetch(url, {
          method: request.method,
          headers,
          body:
            request.method === "GET" ? undefined : await request.arrayBuffer(),
        });
        const outgoing = new Headers(response.headers);
        outgoing.delete("content-encoding");
        outgoing.delete("content-length");
        return new Response(response.body, {
          status: response.status,
          headers: outgoing,
        });
      } catch {
        return Response.json(
          { error: "The local API is unavailable. Run bun run dev." },
          { status: 503 },
        );
      }
    },
    "/*": index,
  },
  development: { hmr: true, console: true },
});
console.log(`Linklog: ${server.url}`);
