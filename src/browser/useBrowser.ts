import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyPatch,
  libraryScope,
  PROTOCOL_VERSION,
  type BrowserCatalog,
  type CommandName,
  type Commands,
  type HelloAck,
  type WindowSnapshot,
} from "@linklog/browser-protocol";
import { BridgeClient, BridgeTimeout, compatibleBrowser } from "./bridge";
import { fetchCatalog } from "./api";

export type Connection =
  | "checking"
  | "unsupported" // not desktop Chromium
  | "missing" // extension not installed / not enabled for this origin
  | "outdated" // protocol mismatch
  | "connected"
  | "reconnecting" // worker restarted; last snapshot kept but stale
  | "reload"; // extension was reloaded; this page must reload

export type BrowserState = ReturnType<typeof useBrowser>;

/** How long to wait for the bridge content script to announce itself. */
const BRIDGE_READY_MS = 2500;
/** The handshake can wake a suspended service worker. */
const HELLO_TIMEOUT_MS = 5000;

/**
 * Connection to the extension for this page's Chrome window. A lost connection
 * keeps the last snapshot (marked stale) — it never reads as an empty window.
 */
export function useBrowser() {
  const client = useRef<BridgeClient | null>(null);
  const [connection, setConnection] = useState<Connection>("checking");
  const [hello, setHello] = useState<HelloAck | null>(null);
  const [snapshot, setSnapshot] = useState<WindowSnapshot | null>(null);
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [resultsVersion, setResultsVersion] = useState(0);
  const snapshotRef = useRef<WindowSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const connecting = useRef(false);

  if (!client.current && typeof window !== "undefined") client.current = new BridgeClient();

  const request = useCallback(
    <K extends CommandName>(command: K, args: Commands[K]["args"], timeout?: number) =>
      client.current!.request(command, args, timeout),
    [],
  );

  const refreshSnapshot = useCallback(async () => {
    try {
      setSnapshot(await request("snapshot", {}));
    } catch {
      /* the lifecycle handler reports disconnection */
    }
  }, [request]);

  const refreshCatalog = useCallback(async () => {
    try {
      const next = await fetchCatalog();
      setCatalog(next);
      setBackendError(null);
      return next;
    } catch (error) {
      setBackendError((error as Error).message);
      return null;
    }
  }, []);

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    try {
      const cat = catalog ?? (await refreshCatalog());
      if (!cat) return;
      if (!compatibleBrowser()) {
        setConnection("unsupported");
        return;
      }
      // No bridge on the page: the extension is missing (or disabled for this site).
      if (!(await client.current!.whenReady(BRIDGE_READY_MS))) {
        setConnection((c) => (c === "reconnecting" ? c : "missing"));
        return;
      }
      // The bridge is there; a cold service worker may take a few seconds to answer.
      const ack = await request("hello", { libraryScope: libraryScope(cat.libraryId) }, HELLO_TIMEOUT_MS);
      if (ack.protocol !== PROTOCOL_VERSION) {
        setConnection("outdated");
        return;
      }
      setHello(ack);
      setConnection("connected");
      setSnapshot(await request("snapshot", {}));
      setResultsVersion((v) => v + 1);
    } catch (error) {
      if (error instanceof BridgeTimeout) setConnection("reconnecting");
      else if (/reloaded/.test((error as Error).message)) setConnection("reload");
      else setConnection((c) => (c === "connected" ? "reconnecting" : "missing"));
    } finally {
      connecting.current = false;
    }
  }, [catalog, refreshCatalog, request]);

  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    const c = client.current!;
    const offEvents = c.onEvent((e) => {
      if (e.event === "snapshot") setSnapshot(e.snapshot);
      else if (e.event === "patch") {
        const current = snapshotRef.current;
        const next = current ? applyPatch(current, e.patch) : null;
        // A missed or reordered patch: reconcile with a full snapshot.
        if (next) setSnapshot(next);
        else void refreshSnapshot();
      } else if (e.event === "scope-changed") {
        setSnapshot(null);
        setHello((h) => (h ? { ...h, windowId: e.windowId } : h));
        void refreshSnapshot();
      } else if (e.event === "access-changed") {
        setHello((h) => (h ? { ...h, contentAccess: e.contentAccess } : h));
      } else if (e.event === "results-changed") setResultsVersion((v) => v + 1);
    });
    const offLife = c.onLifecycle((kind) => {
      if (kind === "disconnected") setConnection((s) => (s === "connected" ? "reconnecting" : s));
      else void connectRef.current();
    });
    void connectRef.current();
    const visible = () => {
      if (document.visibilityState === "visible") {
        // Back to the foreground: reconcile anything the page missed.
        if (snapshotRef.current) void refreshSnapshot();
        else void connectRef.current();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      offEvents();
      offLife();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refreshSnapshot]);

  // Keep retrying quietly while the extension or API is missing/restarting.
  useEffect(() => {
    if (connection === "connected" && !backendError) return;
    if (connection === "unsupported" || connection === "reload" || connection === "outdated") return;
    const timer = setInterval(() => {
      if (backendError) void refreshCatalog().then((c) => c && connectRef.current());
      else void connectRef.current();
    }, connection === "missing" ? 5000 : 2000);
    return () => clearInterval(timer);
  }, [connection, backendError, refreshCatalog]);

  return {
    connection,
    hello,
    snapshot,
    stale: connection !== "connected",
    catalog,
    setCatalog,
    refreshCatalog,
    backendError,
    setBackendError,
    resultsVersion,
    request,
    retry: () => {
      setConnection("checking");
      void refreshCatalog().then(() => connectRef.current());
    },
    libraryScope: catalog ? libraryScope(catalog.libraryId) : null,
  };
}
