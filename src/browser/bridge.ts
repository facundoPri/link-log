import {
  BRIDGE_CHANNEL,
  isExtensionEvent,
  isExtensionResponse,
  type CommandName,
  type Commands,
  type ExtensionEvent,
} from "@linklog/browser-protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class BridgeTimeout extends Error {}

/** Page side of the extension bridge: window.postMessage ↔ content script ↔ background. */
export class BridgeClient {
  private pending = new Map<string, Pending>();
  private events = new Set<(e: ExtensionEvent) => void>();
  private lifecycle = new Set<(kind: "ready" | "disconnected") => void>();

  constructor() {
    window.addEventListener("message", this.onMessage);
  }

  dispose() {
    window.removeEventListener("message", this.onMessage);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Disconnected."));
    }
    this.pending.clear();
  }

  private onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.channel !== BRIDGE_CHANNEL || data.from !== "extension") return;
    if (data.ready) for (const fn of this.lifecycle) fn("ready");
    if (data.disconnected) {
      for (const fn of this.lifecycle) fn("disconnected");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("The extension disconnected."));
        this.pending.delete(id);
      }
    }
    if (isExtensionResponse(data.response)) {
      const r = data.response;
      const p = this.pending.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
    }
    if (isExtensionEvent(data.event)) for (const fn of this.events) fn(data.event);
  };

  onEvent(fn: (e: ExtensionEvent) => void) {
    this.events.add(fn);
    return () => this.events.delete(fn);
  }

  onLifecycle(fn: (kind: "ready" | "disconnected") => void) {
    this.lifecycle.add(fn);
    return () => this.lifecycle.delete(fn);
  }

  request<K extends CommandName>(command: K, args: Commands[K]["args"], timeout = 20_000): Promise<Commands[K]["result"]> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeTimeout("The Linklog extension did not answer."));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      window.postMessage({ channel: BRIDGE_CHANNEL, from: "page", request: { id, command, args } }, location.origin);
    });
  }
}

/** Desktop Chrome/Chromium with extension support. */
export function compatibleBrowser(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string }[]; mobile: boolean } };
  if (nav.userAgentData) return !nav.userAgentData.mobile && nav.userAgentData.brands.some((b) => /Chromium|Google Chrome/.test(b.brand));
  return /Chrome\//.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);
}
