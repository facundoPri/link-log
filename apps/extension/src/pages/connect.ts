import { $, openLinklog, requestContent, revokeContent, status } from "./shared";

async function render() {
  const s = await status();
  const granted = !!s?.contentAccess;
  const badge = $("content-badge");
  badge.className = `badge ${granted ? "ok" : "warn"}`;
  badge.innerHTML = `<span class="dot"></span>${granted ? "Allowed" : "Not allowed"}`;
  $("grant").classList.toggle("hidden", granted);
  $("revoke").classList.toggle("hidden", !granted);
  $("content-hint").classList.toggle("hidden", granted);
  $("status").textContent = s
    ? `Extension ${s.version} · ${s.connectedPages ? `${s.connectedPages} Linklog page${s.connectedPages === 1 ? "" : "s"} connected` : "no Linklog page open"} · works with Linklog on localhost / 127.0.0.1 (any port)${s.origins.length ? ` and ${s.origins.join(", ")}` : ""}`
    : "";
}

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
