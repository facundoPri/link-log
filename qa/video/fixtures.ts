// Fixture catalog for the QA video harness. Shared by the QA Worker entry (which serves it) and by the
// scenarios (which build URLs from it), so a scenario and the server always agree on what a host does.
//
// Every fixture lives on a host under FIXTURE_DOMAIN. The QA Worker answers, for that host:
//  - the DoH lookups validateDestination makes (A record = FIXTURE_IP, a public address),
//  - the preview fetch (extractMetadata) with `preview`,
//  - Browser Rendering's quickAction("markdown"/"content") with `browser`.
// Any path on the host gets the same behaviour, so `fixtureUrl("pool", "a/1")` and `.../a/2` are distinct
// links with identical behaviour. `{path}` in titles and Markdown is replaced with the request path.
// Retry-dependent behaviour ("fail N times, then …") is counted per full URL, so give each run its own path.

export const FIXTURE_DOMAIN = "qa.example";
/** Any public unicast address passes validateDestination; nothing ever connects to it. */
export const FIXTURE_IP = "93.184.215.14";

export type PreviewSpec =
  | { kind: "html"; title: string; description?: string; delayMs?: number }
  /** A non-HTML file (fail-fast `not_html`). */
  | { kind: "pdf"; delayMs?: number }
  /** Any HTTP status, e.g. 404 (fail-fast `not_found`) or 503 (transient `site_error`). */
  | { kind: "status"; status: number; headers?: Record<string, string>; delayMs?: number }
  /** Fails `failures` times with `status`, then behaves like `then`. */
  | { kind: "flaky"; failures: number; status: number; then: PreviewSpec };

export type BrowserSpec =
  | { kind: "markdown"; markdown: string; delayMs?: number; browserMs?: number }
  /** A Browser Rendering error envelope: `{ success:false, errors:[{code,message}] }` with this HTTP status. */
  | { kind: "error"; status: number; code?: number; message: string; delayMs?: number }
  /** Fails `failures` times like `error`, then behaves like `then`. */
  | { kind: "flaky"; failures: number; error: Extract<BrowserSpec, { kind: "error" }>; then: BrowserSpec }
  /** Never answers; the product's attempt budget (100 s) ends it. */
  | { kind: "hang" };

export type Fixture = {
  /** Shown on title cards and in the README catalog. */
  about: string;
  preview: PreviewSpec;
  /** Without it, Browser Rendering answers a short generic article. */
  browser?: BrowserSpec;
  /** "nxdomain" makes DoH return no address (`unreachable`). */
  dns?: "nxdomain";
};

const article = (title: string, extra = "") =>
  `# ${title}\n\nThis is a deterministic QA article served by the fake Browser Rendering binding for {path}. ` +
  `It has enough text to count as a real page and mentions nothing about signing in.\n\n` +
  `## Details\n\nSecond paragraph so the content is not considered empty. ${extra}`.trim();

export const FIXTURES = {
  // FAC-48 scenario A: links that wait behind the 2-slot browser pool for longer than 30 s.
  pool: {
    about: "HTML preview (fast); Browser Markdown answers after 12 s, so later links queue behind the 2-slot pool",
    preview: { kind: "html", title: "Pooled article {path}", description: "A normal page that only takes a while to render." },
    browser: { kind: "markdown", markdown: article("Pooled article {path}"), delayMs: 12_000, browserMs: 12_000 },
  },
  article: {
    about: "HTML preview and Markdown, both immediate",
    preview: { kind: "html", title: "QA article {path}", description: "A normal page." },
    browser: { kind: "markdown", markdown: article("QA article {path}") },
  },
  pdf: {
    about: "Preview answers application/pdf (fail-fast not_html); Browser Markdown never gets the page either",
    preview: { kind: "pdf" },
    browser: { kind: "error", status: 415, message: "Unsupported content type application/pdf" },
  },
  gone: {
    about: "Preview answers 404 (fail-fast not_found); Browser Markdown errors with 404",
    preview: { kind: "status", status: 404 },
    browser: { kind: "error", status: 404, message: "Navigation failed: HTTP 404" },
  },
  flaky: {
    about: "Preview answers 503 once, then 200 HTML (transient site_error, recovered by the retry)",
    preview: { kind: "flaky", failures: 1, status: 503, then: { kind: "html", title: "Recovered article {path}" } },
    browser: { kind: "markdown", markdown: article("Recovered article {path}") },
  },
  down: {
    about: "Preview answers 503 every time (site_error after all retries)",
    preview: { kind: "status", status: 503 },
    browser: { kind: "error", status: 502, message: "Navigation failed: HTTP 502" },
  },
  slow: {
    about: "Preview answers after 25 s (the preview fetch gives up at 10 s → timeout, retried twice)",
    preview: { kind: "html", title: "Slow article {path}", delayMs: 25_000 },
    browser: { kind: "markdown", markdown: article("Slow article {path}") },
  },
  blocked: {
    about: "Preview 403 with cf-mitigated (fail-fast blocked)",
    preview: { kind: "status", status: 403, headers: { "cf-mitigated": "challenge" } },
    browser: { kind: "error", status: 403, message: "Navigation failed: HTTP 403" },
  },
  nowhere: {
    about: "DoH returns no address (unreachable)",
    preview: { kind: "html", title: "never served" },
    dns: "nxdomain",
  },
  "login-wall": {
    about: "HTML preview OK; Browser Markdown returns a short login page (FAC-57 login_wall)",
    preview: { kind: "html", title: "Members article {path}", description: "Behind a login." },
    browser: { kind: "markdown", markdown: "# Sign in\n\nLog in to continue\n\nEmail\n\nPassword\n\nForgot your password?" },
  },
  "render-timeout": {
    about: "HTML preview OK; Browser Markdown answers 422 'Navigation timeout' (timeout, retried once)",
    preview: { kind: "html", title: "Heavy article {path}" },
    browser: { kind: "error", status: 422, code: 2001, message: "Navigation timeout of 45000 ms exceeded" },
  },
  "browser-auth": {
    about: "HTML preview OK; Browser Rendering answers 403 'Authentication error' (service_unavailable, no retry)",
    preview: { kind: "html", title: "Article {path}" },
    browser: { kind: "error", status: 403, code: 10000, message: "Authentication error" },
  },
  "browser-flaky": {
    about: "HTML preview OK; Browser Markdown fails once with 502, then succeeds",
    preview: { kind: "html", title: "Eventually rendered {path}" },
    browser: { kind: "flaky", failures: 1, error: { kind: "error", status: 502, message: "Bad gateway" }, then: { kind: "markdown", markdown: article("Eventually rendered {path}") } },
  },
  "browser-empty": {
    about: "HTML preview OK; Browser Markdown returns an empty result (empty)",
    preview: { kind: "html", title: "Blank article {path}" },
    browser: { kind: "markdown", markdown: "  " },
  },
  "browser-hang": {
    about: "HTML preview OK; Browser Markdown never answers (attempt budget timeout, 100 s × 2)",
    preview: { kind: "html", title: "Hanging article {path}" },
    browser: { kind: "hang" },
  },
  // Jev account / provider errors. Only effective with the fake TypeSafe provider (QA_JEV=fake-typesafe):
  // the fake answers the HTTP status named by the `qa:jev-http=<status>` marker in the content.
  "jev-401": {
    about: "Article whose content makes the fake TypeSafe Jev answer 401 (account)",
    preview: { kind: "html", title: "Jev 401 article {path}" },
    browser: { kind: "markdown", markdown: article("Jev 401 article {path}", "qa:jev-http=401") },
  },
  "jev-402": {
    about: "Article whose content makes the fake TypeSafe Jev answer 402 (account)",
    preview: { kind: "html", title: "Jev 402 article {path}" },
    browser: { kind: "markdown", markdown: article("Jev 402 article {path}", "qa:jev-http=402") },
  },
  "jev-500": {
    about: "Article whose content makes the fake TypeSafe Jev answer 500 (provider_error)",
    preview: { kind: "html", title: "Jev 500 article {path}" },
    browser: { kind: "markdown", markdown: article("Jev 500 article {path}", "qa:jev-http=500") },
  },
} satisfies Record<string, Fixture>;

export type FixtureName = keyof typeof FIXTURES;

/** The URL of a fixture. `path` makes distinct links with the same behaviour. */
export function fixtureUrl(name: FixtureName, path = ""): string {
  return `https://${name}.${FIXTURE_DOMAIN}/${path.replace(/^\/+/, "")}`;
}

/** The fixture a hostname serves, or null when it is not a fixture host. */
export function fixtureFor(hostname: string): Fixture | null {
  if (!hostname.endsWith(`.${FIXTURE_DOMAIN}`)) return null;
  const name = hostname.slice(0, -FIXTURE_DOMAIN.length - 1);
  return (FIXTURES as Record<string, Fixture>)[name] ?? null;
}
