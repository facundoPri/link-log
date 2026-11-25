import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { catalogQuery } from "./api";
import { onSignedOut } from "../auth-client";
import { extensionUpdate } from "./extensionVersion";

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
  const queryClient = useQueryClient();
  const client = useRef<BridgeClient | null>(null);
  const [connection, setConnection] = useState<Connection>("checking");
  const [hello, setHello] = useState<HelloAck | null>(null);
  /** What the installed extension reported in its handshake, even when its protocol doesn't match. */
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WindowSnapshot | null>(null);
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [resultsVersion, setResultsVersion] = useState(0);
  const snapshotRef = useRef<WindowSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const connecting = useRef(false);
  // An extension on another protocol still subscribes this page on hello and pushes events in its
  // own shapes; nothing it sends is read until a handshake on PROTOCOL_VERSION succeeds.
  const protocolMatched = useRef(false);

  if (!client.current && typeof window !== "undefined") client.current = new BridgeClient();

  const request = useCallback(
    <K extends CommandName>(command: K, args: Commands[K]["args"], timeout?: number) =>
      client.current!.request(command, args, timeout),
    [],
  );

  const refreshSnapshot = useCallback(async () => {
    if (!protocolMatched.current) return;
    try {
      setSnapshot(await request("snapshot", {}));
    } catch {
      /* the lifecycle handler reports disconnection */
    }
  }, [request]);

  const refreshCatalog = useCallback(async () => {
    try {
      // fetchQuery joins a read already in flight, which may predate a write this refresh follows: let it
      // land, then read again so the catalog returned started after the caller's write.
      if (queryClient.isFetching({ queryKey: catalogQuery.queryKey }) > 0)
        await queryClient.fetchQuery(catalogQuery).catch(() => {});
      const next = await queryClient.fetchQuery(catalogQuery);
      setCatalog(next);
      setBackendError(null);
      return next;
    } catch (error) {
      setBackendError((error as Error).message);
      return null;
    }
  }, [queryClient]);

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
      protocolMatched.current = false;
      const ack = await request("hello", { libraryScope: libraryScope(cat.libraryId) }, HELLO_TIMEOUT_MS);
      setInstalledVersion(typeof ack?.extensionVersion === "string" ? ack.extensionVersion : null);
      if (ack?.protocol !== PROTOCOL_VERSION) {
        setSnapshot(null);
        setConnection("outdated");
        return;
      }
      protocolMatched.current = true;
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

  // Sign-out: the extension drops this account's cached results (its library scope) and the
  // handshake. Other accounts use other library ids, so they never read them anyway.
  const helloRef = useRef(hello);
  helloRef.current = hello;
  useEffect(
    () =>
      onSignedOut(async () => {
        if (helloRef.current?.capabilities.includes("forget")) await request("forget", {}, 1000);
      }),
    [request],
  );

  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    const c = client.current!;
    const offEvents = c.onEvent((e) => {
      if (!protocolMatched.current) return;
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
      if (kind === "disconnected") {
        protocolMatched.current = false;
        setConnection((s) => (s === "connected" ? "reconnecting" : s));
      }
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
    installedVersion,
    /** Set when the extension speaks this protocol but is older than the version built with this page. */
    update: connection === "connected" ? extensionUpdate(installedVersion) : null,
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
