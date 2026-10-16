/** Recognize destinations used for access checks, not articles that discuss login. */
export function accessInterstitial(url: URL) {
  return ["consent.youtube.com", "consent.google.com", "accounts.google.com"].includes(url.hostname) ||
    (url.hostname === "www.google.com" && url.pathname.startsWith("/sorry/")) ||
    /\/(?:gz\/account-verification|jms\/[^/]+\/lgz\/login|login|signin|sign-in|auth\/login|account\/login|challenge)\/?$/i.test(url.pathname);
}

export const ACCESS_PAGE_ERROR = "The site returned a sign-in or verification page. Any saved preview and text were kept. Open the original link to view the page.";

export function accessPageTitle(title: string) {
  return /^(?:just a moment[.!…]*|attention required!?\s*\|\s*cloudflare|verify you are human)$/i.test(title.trim());
}

/** Narrow fallback for older Browser responses without finalUrl metadata. */
export function mercadoLoginText(text: string) {
  return /para continuar,\s*ingresa a\s*tu cuenta/i.test(text) &&
    /\[Ya tengo cuenta\]\(https:\/\/www\.mercadolibre\.[^\s)]+\/jms\//i.test(text);
}
