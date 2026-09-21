import { serve } from "bun";
import index from "./index.html";
const server = serve({
  port: 3000,
  hostname: "127.0.0.1",
  routes: {
    "/api/*": async (request) => {
      const url = new URL(request.url);
      url.hostname = "127.0.0.1";
      url.port = "8787";
      const headers = new Headers(request.headers);
      headers.delete("host");
      // Wrangler is bound to loopback; preserve same-origin checks at the browser boundary.
      const origin = headers.get("origin");
      if (origin && origin !== new URL(request.url).origin)
        return Response.json(
          { error: "Origen no permitido." },
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
          { error: "La API local no está disponible. Ejecutá bun run dev." },
          { status: 503 },
        );
      }
    },
    "/*": index,
  },
  development: { hmr: true, console: true },
});
console.log(`Linklog: ${server.url}`);
