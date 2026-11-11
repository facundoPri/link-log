/// <reference types="chrome" />
// Raw CDP for checks that discard tabs. Playwright attaches to every page target, and a
// discard under it crashed Chromium 153 in the FAC-163 probe; this client attaches only to
// the extension worker and the pages it is told to.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export type Target = { targetId: string; type: string; url: string };
type Listener = (method: string, params: any) => void;

export class Cdp {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  private listeners = new Set<Listener>();
  async open(url: string) {
    this.ws = new WebSocket(url);
    await new Promise((r, j) => ((this.ws.onopen = r), (this.ws.onerror = j)));
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      } else for (const fn of this.listeners) fn(m.method, m.params);
    };
  }
  send(method: string, params: object = {}, sessionId?: string, timeout = 120_000): Promise<any> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method}: no answer in ${timeout / 1000}s`))), timeout);
      this.pending.set(id, (m) => (clearTimeout(timer), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    });
  }
  on(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  close() {
    this.ws.close();
  }
}

export type RawBrowser = {
  cdp: Cdp;
  version: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** Runs `fn(arg)` in the Linklog extension's service worker. */
  sw<R, A>(fn: (arg: A) => Promise<R>, arg: A): Promise<R>;
  /** Evaluates an expression in the first page whose URL contains `urlPart`. */
  page<R>(urlPart: string, expression: string): Promise<R>;
  screenshot(urlPart: string, path: string): Promise<void>;
  targets(): Promise<Target[]>;
  /** Stops the extension's worker the way Chrome suspends it. */
  stopWorker(): Promise<void>;
  close(): Promise<void>;
};

export async function launchRaw(opts: {
  profile: string;
  extension: string;
  port: number;
  fresh?: boolean;
  args?: string[];
  cookie?: { name: string; value: string; domain: string } | null;
}): Promise<RawBrowser> {
  if (opts.fresh) await rm(opts.profile, { recursive: true, force: true });
  const exe = process.env.CHROME_PATH ?? chromium.executablePath();
  const proc = Bun.spawn(
    [exe, `--user-data-dir=${opts.profile}`, `--remote-debugging-port=${opts.port}`, `--disable-extensions-except=${opts.extension}`, `--load-extension=${opts.extension}`,
      "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "--window-size=1280,820",
      ...(process.env.HEADED ? [] : ["--headless=new"]), ...(opts.args ?? []), "about:blank"],
    { stdout: "ignore", stderr: Bun.file(resolve(opts.profile + ".log")) },
  );
  let version: any = null;
  for (let i = 0; i < 150 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${opts.port}/json/version`).then((r) => r.json()).catch(() => null);
    if (!version) await Bun.sleep(100);
  }
  if (!version) throw new Error("Chromium did not start");
  const cdp = new Cdp();
  await cdp.open(version.webSocketDebuggerUrl);
  if (opts.cookie)
    await cdp.send("Storage.setCookies", { cookies: [{ ...opts.cookie, path: "/", httpOnly: true, sameSite: "Lax", secure: false }] });
  let swSession = "";
  let swTarget = "";
  const attachWorker = async () => {
    for (let i = 0; i < 150; i++) {
      const workers = (await cdp.send("Target.getTargets")).targetInfos.filter((t: Target) => t.type === "service_worker" && t.url.endsWith("/background.js"));
      for (const t of workers) {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        const name = await cdp.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, sessionId).catch(() => null);
        if (name?.result?.value === "Linklog") {
          swTarget = t.targetId;
          return (swSession = sessionId);
        }
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
      await Bun.sleep(100);
    }
    throw new Error("Linklog service worker not found");
  };
  await attachWorker();
  const evaluate = async (sessionId: string, expression: string) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const withPage = async <R>(urlPart: string, fn: (sessionId: string) => Promise<R>): Promise<R> => {
    const target = (await cdp.send("Target.getTargets")).targetInfos.find((t: Target) => t.type === "page" && t.url.includes(urlPart));
    if (!target) throw new Error(`no page for ${urlPart}`);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try {
      return await fn(sessionId);
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  };
  const browser: RawBrowser = {
    cdp,
    version: version.Browser,
    proc,
    async sw(fn, arg) {
      const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
      try {
        return await evaluate(swSession, expression);
      } catch (error) {
        // The worker was suspended or restarted: find it again and retry once.
        if (!/No session|Target closed|not found|wasn't found|detached/i.test(String(error))) throw error;
        await attachWorker();
        return evaluate(swSession, expression);
      }
    },
    page: (urlPart, expression) => withPage(urlPart, (s) => evaluate(s, expression)),
    screenshot: (urlPart, path) =>
      withPage(urlPart, async (s) => {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
        await Bun.write(path, Buffer.from(data, "base64"));
      }),
    targets: async () => (await cdp.send("Target.getTargets")).targetInfos,
    async stopWorker() {
      await cdp.send("Target.closeTarget", { targetId: swTarget });
      swSession = "";
    },
    async close() {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
      await proc.exited;
    },
  };
  return browser;
}
