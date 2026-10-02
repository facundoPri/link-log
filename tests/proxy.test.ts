// The local Bun proxy must hand auth redirects and every cookie to the browser untouched,
// forward Origin as-is (so the Worker can reject it) and drop client-forged IP headers.
import { afterAll, expect, test } from "bun:test";
import { proxyApi } from "../src/proxy";

let seen: Headers | undefined;
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    seen = request.headers;
    const headers = new Headers({ location: "/after-login" });
    headers.append("set-cookie", "linklog.session_token=abc; Path=/; HttpOnly; SameSite=Lax");
    headers.append("set-cookie", "linklog.session_data=; Max-Age=0; Path=/");
    return new Response(null, { status: 302, headers });
  },
});
afterAll(() => upstream.stop(true));

test("redirects are not followed and all Set-Cookie headers survive", async () => {
  const response = await proxyApi(
    new Request("http://localhost:3000/api/auth/magic-link/verify?token=t", {
      headers: { origin: "http://localhost:3000", "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "6.6.6.6", cookie: "a=b" },
    }),
    upstream.port!,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/after-login");
  expect(response.headers.getSetCookie()).toEqual([
    "linklog.session_token=abc; Path=/; HttpOnly; SameSite=Lax",
    "linklog.session_data=; Max-Age=0; Path=/",
  ]);
  expect(seen!.get("origin")).toBe("http://localhost:3000");
  expect(seen!.get("cookie")).toBe("a=b");
  expect(seen!.get("cf-connecting-ip")).toBeNull();
  expect(seen!.get("x-forwarded-for")).toBeNull();
});

test("a foreign Origin is forwarded unchanged for the Worker to reject", async () => {
  await proxyApi(new Request("http://localhost:3000/api/links", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), upstream.port!);
  expect(seen!.get("origin")).toBe("https://evil.example");
});

test("an unreachable API answers 503", async () => {
  const response = await proxyApi(new Request("http://localhost:3000/api/library"), 1);
  expect(response.status).toBe(503);
});
