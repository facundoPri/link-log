import { LOCAL_BRIDGE_MATCHES } from "@linklog/browser-protocol";
import { CONSENT_KEY } from "../config";
import { $, openLinklog, requestContent, revokeContent, status } from "./shared";

// Where the bridge runs, from the built manifest: packaged builds have no localhost matches (FAC-306).
function bridgeOrigins() {
  const matches = chrome.runtime.getManifest().content_scripts?.[0]?.matches ?? [];
  const others = matches.filter((m) => !LOCAL_BRIDGE_MATCHES.includes(m)).map((m) => m.replace(/\/\*$/, ""));
  return matches.length > others.length ? ["localhost / 127.0.0.1 (any port)", ...others] : others;
}

async function render() {
  const s = await status();
  // Consent first (FAC-305): the permissions card only makes sense once the extension runs.
  $("consent").classList.toggle("hidden", !s || s.consent);
  $("permissions").classList.toggle("hidden", !s?.consent);
  const granted = !!s?.contentAccess;
  const badge = $("content-badge");
  badge.className = `badge ${granted ? "ok" : "warn"}`;
  badge.innerHTML = `<span class="dot"></span>${granted ? "Allowed" : "Not allowed"}`;
  $("grant").classList.toggle("hidden", granted);
  $("revoke").classList.toggle("hidden", !granted);
  $("content-hint").classList.toggle("hidden", granted);
  $("status").textContent = s
    ? `Extension ${s.version} · ${s.connectedPages ? `${s.connectedPages} Linklog page${s.connectedPages === 1 ? "" : "s"} connected` : "no Linklog page open"} · works with Linklog on ${bridgeOrigins().join(" and ")}`
    : "";
}

$("accept").addEventListener("click", async () => {
  // The background starts when it sees this key (chrome.storage.onChanged).
  await chrome.storage.local.set({ [CONSENT_KEY]: true });
  await render();
});
$("grant").addEventListener("click", async () => {
  await requestContent();
  await render();
});
$("revoke").addEventListener("click", async () => {
  await revokeContent();
  await render();
});
$("open").addEventListener("click", () => void openLinklog());
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());
void render();
