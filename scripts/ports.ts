// Local URLs and ports shared by dev, the proxy, the Chrome launcher and browser tests.
// Defaults: UI 3000, API 8787. Override with LINKLOG_UI_PORT / LINKLOG_API_PORT.
export const HOST = "127.0.0.1";
export function uiPort() {
  return Number(process.env.LINKLOG_UI_PORT) || 3000;
}
export function apiPort() {
  return Number(process.env.LINKLOG_API_PORT) || 8787;
}
export function uiUrl() {
  return `http://${HOST}:${uiPort()}`;
}
export function apiUrl() {
  return `http://${HOST}:${apiPort()}`;
}
/** Origins allowed to reach the extension bridge; baked into the extension build. */
export function linklogOrigins(): string[] {
  const configured = process.env.LINKLOG_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  if (configured?.length) return [...new Set(configured.map((o) => new URL(o).origin))].sort();
  const ports = [...new Set([uiPort(), apiPort()])];
  return ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]).sort();
}

export async function portInUse(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: HOST, port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}
