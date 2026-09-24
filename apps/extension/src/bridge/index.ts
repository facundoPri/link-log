import {
  BRIDGE_CHANNEL,
  BRIDGE_PORT,
  PROTOCOL_VERSION,
  isExtensionEvent,
  isExtensionResponse,
  parseEnvelope,
} from "@linklog/browser-protocol";
import { EXTENSION_VERSION } from "../config";

// Runs only on configured Linklog origins (manifest + background re-checks origin
// and frame). It relays validated messages between the page and the background.
// It holds no privileges of its own and never touches other sites.

const origin = location.origin;
let port: chrome.runtime.Port | null = null;
let retry = 250;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function post(message: Record<string, unknown>) {
  window.postMessage({ channel: BRIDGE_CHANNEL, from: "extension", ...message }, origin);
}

function alive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function connect(): chrome.runtime.Port | null {
  if (port) return port;
  if (!alive()) return null;
  try {
    port = chrome.runtime.connect({ name: BRIDGE_PORT });
  } catch {
    return null;
  }
  retry = 250;
  port.onMessage.addListener((message) => {
    if (isExtensionResponse(message)) post({ response: message });
    else if (message && typeof message === "object" && isExtensionEvent((message as { event?: unknown }).event))
      post({ event: (message as { event: unknown }).event });
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // The worker was suspended or restarted: tell the page to re-handshake and
    // reconcile with a fresh snapshot, then reconnect (which wakes the worker).
    post({ disconnected: true });
    if (!alive()) return; // extension reloaded or removed; the page must reload
    setTimeout(() => {
      if (connect()) post({ ready: { version: EXTENSION_VERSION, protocol: PROTOCOL_VERSION } });
    }, retry);
    retry = Math.min(retry * 2, 5000);
  });
  if (!heartbeat)
    heartbeat = setInterval(() => {
      // Messages keep the worker awake only while Linklog is open and visible.
      if (document.visibilityState === "visible") port?.postMessage({ heartbeat: true });
    }, 20_000);
  return port;
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== origin) return;
  const envelope = parseEnvelope(event.data);
  if (!envelope || envelope.from !== "page") return;
  const p = connect();
  if (!p) {
    post({ response: { id: envelope.request.id, ok: false, error: "The Linklog extension was reloaded. Reload this page." } });
    return;
  }
  p.postMessage(envelope.request);
});

document.documentElement.dataset.linklogBridge = String(PROTOCOL_VERSION);
connect();
post({ ready: { version: EXTENSION_VERSION, protocol: PROTOCOL_VERSION } });
