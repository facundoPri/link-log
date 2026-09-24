import { $, kb, openLinklog, status } from "./shared";

async function render() {
  const s = await status();
  if (!s) return;
  $("version").textContent = `v${s.version}`;
  const pages = $("pages");
  pages.className = `badge ${s.connectedPages ? "ok" : ""}`;
  pages.innerHTML = s.connectedPages ? `<span class="dot"></span>${s.connectedPages} connected` : "Not open";
  const content = $("content");
  content.className = `badge ${s.contentAccess ? "ok" : "warn"}`;
  content.innerHTML = `<span class="dot"></span>${s.contentAccess ? "Allowed" : "Not allowed"}`;
  $("cache").textContent = `${kb(s.cache.bytes)} of ${kb(s.cache.quota)}`;
}

$("open").addEventListener("click", () => void openLinklog().then(() => window.close()));
$("permissions").addEventListener("click", () =>
  void chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") }).then(() => window.close()),
);
void render();
