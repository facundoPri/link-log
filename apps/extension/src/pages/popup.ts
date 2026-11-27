import { $, kb, openLinklog, status } from "./shared";

async function render() {
  const s = await status();
  if (!s) return;
  $("version").textContent = `v${s.version}`;
  const pages = $("pages");
  const [tone, label] = !s.consent
    ? ["warn", `<span class="dot"></span>Not connected`]
    : s.connectedPages
      ? ["ok", `<span class="dot"></span>${s.connectedPages} connected`]
      : ["", "Not open"];
  pages.className = `badge ${tone}`;
  pages.innerHTML = label;
  $("permissions").textContent = s.consent ? "Permissions" : "Review and connect";
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
