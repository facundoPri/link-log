// Local dev proxy from the Bun UI server to Wrangler. Kept separate from src/index.ts so tests can
// exercise it without the HTML bundle.
// Headers a browser could forge to influence rate limiting or URL inference upstream.
const SPOOFABLE = ["host", "cf-connecting-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];

export async function proxyApi(request: Request, upstreamPort: number) {
  const incoming = new URL(request.url);
  const url = new URL(incoming.pathname + incoming.search, `http://127.0.0.1:${upstreamPort}`);
  const headers = new Headers(request.headers);
  for (const name of SPOOFABLE) headers.delete(name);
  // Origin is forwarded untouched: the Worker and Better Auth validate it against the public origin.
  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      // Auth callbacks answer with redirects + cookies; the browser must receive them, not the proxy.
      redirect: "manual",
    });
    const outgoing = new Headers();
    response.headers.forEach((value, name) => {
      if (!["set-cookie", "content-encoding", "content-length"].includes(name)) outgoing.set(name, value);
    });
    for (const cookie of response.headers.getSetCookie()) outgoing.append("set-cookie", cookie);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
  } catch {
    return Response.json({ error: "The local API is unavailable. Run bun run dev." }, { status: 503 });
  }
}
