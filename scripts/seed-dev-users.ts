// Idempotent A/B fixtures for a DISPOSABLE local state dir. Accounts go through the real Better
// Auth endpoints (sign-up -> simulated email -> verification link), so passwords are hashed by
// Better Auth and nothing bypasses verification. No real/legacy data is assigned to them.
//   LINKLOG_STATE_DIR=.wrangler/demo-state LINKLOG_API_PORT=8800 LINKLOG_UI_PORT=3100 bun scripts/seed-dev-users.ts
// (scripts/demo.ts runs it automatically.)
import { resolve } from "node:path";
import { waitForMail } from "./lib/local-mail";

export const FIXTURES = [
  { label: "Demo A", email: "demo-a@linklog.test", password: "linklog-demo-a-password" },
  { label: "Demo B", email: "demo-b@linklog.test", password: "linklog-demo-b-password" },
];

export function assertDisposableTarget(apiUrl: string, stateDir: string) {
  const host = new URL(apiUrl).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("Fixtures only seed a loopback Worker.");
  if (resolve(stateDir) === resolve(".wrangler/state"))
    throw new Error("Refusing to seed the default state dir (.wrangler/state may hold real data). Use LINKLOG_STATE_DIR.");
}

type Session = { cookie: string };

async function post(apiUrl: string, origin: string, path: string, body: unknown, cookie = "") {
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}
const cookieOf = (response: Response) =>
  response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signIn(apiUrl: string, origin: string, email: string, password: string) {
  return post(apiUrl, origin, "/api/auth/sign-in/email", { email, password });
}

async function verifyFromMail(apiUrl: string, email: string, since: number) {
  const link = new URL(await waitForMail(email, "verify", since));
  const response = await fetch(`${apiUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`Verification failed for ${email} (${response.status}).`);
}

export async function ensureFixture(apiUrl: string, origin: string, fixture: (typeof FIXTURES)[number]): Promise<Session> {
  let response = await signIn(apiUrl, origin, fixture.email, fixture.password);
  if (response.ok) return { cookie: cookieOf(response) };
  const since = Date.now();
  if (response.status === 401) {
    const signUp = await post(apiUrl, origin, "/api/auth/sign-up/email", {
      email: fixture.email,
      password: fixture.password,
      name: fixture.label,
      callbackURL: "/",
    });
    if (!signUp.ok) throw new Error(`Sign-up failed for ${fixture.email} (${signUp.status}).`);
  } else if (response.status !== 403) {
    throw new Error(`Sign-in failed for ${fixture.email} (${response.status}).`);
  }
  // 403 = exists but unverified; sign-in already re-sent the verification email.
  await verifyFromMail(apiUrl, fixture.email, since);
  response = await signIn(apiUrl, origin, fixture.email, fixture.password);
  if (!response.ok) throw new Error(`Sign-in after verification failed for ${fixture.email} (${response.status}).`);
  return { cookie: cookieOf(response) };
}

/** Both users save the same URL, tag and lens name, plus one private link each. Re-running dedupes. */
async function sampleData(apiUrl: string, origin: string, label: string, session: Session) {
  const send = async (path: string, body: unknown, method = "POST") => {
    const response = await fetch(`${apiUrl}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: session.cookie },
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 409) throw new Error(`${label}: ${method} ${path} -> ${response.status}`);
  };
  await send("/links", { url: "https://example.com/shared-demo", tags: ["shared"] });
  await send("/links", { url: `https://example.com/${label.toLowerCase().replace(/\W+/g, "-")}-only`, tags: ["private"] });
  await send("/lenses", { name: "Worth reading", type: "noul", question: "Is this worth reading later?" });
}

export async function seedFixtures(apiUrl: string, origin: string, stateDir: string) {
  assertDisposableTarget(apiUrl, stateDir);
  for (const fixture of FIXTURES) {
    const session = await ensureFixture(apiUrl, origin, fixture);
    await sampleData(apiUrl, origin, fixture.label, session);
    console.log(`Fixture ready: ${fixture.email}`);
  }
}

if (import.meta.main) {
  const apiPort = Number(process.env.LINKLOG_API_PORT || 8787);
  const uiPort = Number(process.env.LINKLOG_UI_PORT || 3000);
  await seedFixtures(`http://127.0.0.1:${apiPort}`, `http://localhost:${uiPort}`, process.env.LINKLOG_STATE_DIR || ".wrangler/state");
}
