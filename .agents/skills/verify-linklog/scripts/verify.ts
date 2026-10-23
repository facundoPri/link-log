// Isolated Linklog instance for verification: the QA Worker from qa/video (fixture DNS, previews, Browser
// Rendering and Jev; every other outbound fetch refused, so nothing paid runs) on its own ports and state,
// with two accounts created through the real sign-up + emailed verification flow.
//   bun .agents/skills/verify-linklog/scripts/verify.ts up [--ui-port N --api-port N] [--fast-retries] [--var K=V]...
//   bun .agents/skills/verify-linklog/scripts/verify.ts doctor [--run DIR]
//   bun .agents/skills/verify-linklog/scripts/verify.ts run <journey.ts> [--run DIR] [--headed]
//   bun .agents/skills/verify-linklog/scripts/verify.ts down [--run DIR]
// Runs live in .cache/verify-linklog/<run>/; `down` deletes the instance state and keeps evidence/ and logs/.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const ROOT = resolve(realpathSync(import.meta.dir), "../../../..");
const BASE = resolve(ROOT, ".cache/verify-linklog");
const POINTER = join(BASE, "current");
/** Code the instance runs. A newer file than the launch means the instance is stale. */
const SOURCES = ["src", "worker", "migrations", "qa/video", "scripts"];

type Account = { label: string; email: string; password: string; cookie: string };
export type Session = {
  pid: number;
  runDir: string;
  ui: string;
  api: string;
  startedAt: number;
  commit: string;
  options: { fastRetries: boolean; vars: Record<string, string> };
  accounts: Account[];
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const opts = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const rel = (p: string) => relative(ROOT, p) || ".";

async function portBusy(port: number) {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}

async function listenerPids(port: number) {
  return (await sh(["lsof", "-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"])).split(/\s+/).filter(Boolean).map(Number);
}

/** `serve` runs detached, so it leads its own process group: every process the run started, orphans included. */
async function groupPids(pgid: number) {
  return (await sh(["ps", "-A", "-o", "pid=,pgid="]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== pgid)
    .map(([pid]) => pid!);
}

/** Stops every process of the run: TERM, then KILL whatever is left after 5 s. */
async function stopGroup(pgid: number) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pgid, signal);
    } catch {
      return;
    }
    for (let i = 0; i < 25; i++) {
      if (!(await groupPids(pgid)).length && !alive(pgid)) return;
      await Bun.sleep(200);
    }
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function runDirArg() {
  const dir = opt("--run") ?? (existsSync(POINTER) ? readFileSync(POINTER, "utf8").trim() : "");
  if (!dir) throw new Error("No run. Start one with `verify.ts up`, or pass --run <dir>.");
  return resolve(ROOT, dir);
}

export function loadSession(runDir = runDirArg()): Session {
  const path = join(runDir, "session.json");
  if (!existsSync(path)) throw new Error(`${rel(path)} is missing: the instance is not up (or was taken down).`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function newestSource(since: number) {
  let newest: { path: string; mtime: number } | null = null;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "out" || name.startsWith(".")) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.mtimeMs > since && (!newest || st.mtimeMs > newest.mtime)) newest = { path, mtime: st.mtimeMs };
    }
  };
  for (const dir of SOURCES) if (existsSync(resolve(ROOT, dir))) walk(resolve(ROOT, dir));
  return newest as { path: string; mtime: number } | null;
}

/** Parent side of `up`: picks ports, starts `serve` detached, returns once the instance is usable. */
async function up() {
  let ui = Number(opt("--ui-port")) || 0;
  let api = Number(opt("--api-port")) || 0;
  if (!ui || !api) {
    // Wrangler also takes api + 1000 for its inspector.
    for (let k = 0; k < 20 && !ui; k++) {
      const [u, a] = [3400 + k * 10, 9100 + k * 10];
      if (!(await portBusy(u)) && !(await portBusy(a)) && !(await portBusy(a + 1000))) [ui, api] = [u, a];
    }
    if (!ui) throw new Error("No free port pair between 3400/9100 and 3590/9290. Pass --ui-port and --api-port.");
  }
  const runDir = join(BASE, `${stamp()}-${ui}`);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const log = openSync(join(runDir, "logs/verify.log"), "a");
  const child = spawn(process.execPath, [import.meta.path, "serve", "--run", runDir, "--ui-port", String(ui), "--api-port", String(api), ...args.filter((a, i) => a === "--fast-retries" || a === "--var" || args[i - 1] === "--var")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (existsSync(join(runDir, "session.json"))) {
      const s = loadSession(runDir);
      writeFileSync(POINTER, rel(runDir));
      console.log(`READY ${s.ui}\nrun: ${rel(runDir)}\naccounts: ${s.accounts.map((a) => a.email).join(", ")}\nlogs: ${rel(join(runDir, "logs"))}`);
      process.exit(0);
    }
    if (exited !== null) break;
    await Bun.sleep(300);
  }
  const tail = readFileSync(join(runDir, "logs/verify.log"), "utf8").split("\n").slice(-25).join("\n");
  console.error(`The instance did not become ready${exited !== null ? ` (serve exited ${exited})` : " within 180 s"}.\n${tail}\nMore: ${rel(join(runDir, "logs"))}`);
  await stopGroup(child.pid!);
  process.exit(1);
}

/** Child side of `up`: owns the stack until SIGTERM. */
async function serve() {
  const runDir = resolve(opt("--run")!);
  process.env.QA_OUT = runDir;
  process.env.QA_UI_PORT = opt("--ui-port")!;
  process.env.QA_API_PORT = opt("--api-port")!;
  process.env.LINKLOG_PERSIST_TO = join(runDir, "state");
  const vars = Object.fromEntries(opts("--var").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  const options = { fastRetries: flag("--fast-retries"), vars };
  const { startEnv } = await import(resolve(ROOT, "qa/video/env.ts"));
  const { ensureFixture, FIXTURES } = await import(resolve(ROOT, "scripts/seed-dev-users.ts"));
  const env = await startEnv(options);
  const stop = async () => {
    await env.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    // startEnv already created both accounts and returned Demo A's session. Better Auth rate-limits sign-in,
    // so Demo B's session waits out a 429 instead of failing the launch.
    const accounts: Account[] = [{ ...FIXTURES[0]!, cookie: env.cookie }];
    for (let attempt = 0; accounts.length < 2; attempt++) {
      try {
        accounts.push({ ...FIXTURES[1]!, cookie: (await ensureFixture(env.api, env.ui, FIXTURES[1]!)).cookie });
      } catch (e) {
        if (!String(e).includes("(429)") || attempt >= 15) throw e;
        await Bun.sleep(2000);
      }
    }
    // Ready means usable: the proxy answers, the session cookie is accepted, the library loads.
    const library = await fetch(`${env.ui}/api/library`, { headers: { Cookie: accounts[0]!.cookie } });
    if (library.status !== 200) throw new Error(`GET /api/library as ${accounts[0]!.email} → ${library.status}`);
    const session: Session = {
      pid: process.pid,
      runDir,
      ui: env.ui,
      api: env.api,
      startedAt: Date.now(),
      commit: `${await sh(["git", "rev-parse", "--short", "HEAD"])}${(await sh(["git", "status", "--porcelain", "--", ...SOURCES])) ? "+dirty" : ""}`,
      options,
      accounts,
    };
    writeFileSync(join(runDir, "session.json"), JSON.stringify(session, null, 2), { mode: 0o600 });
    console.log(`serve: ready at ${env.ui} (pid ${process.pid})`);
  } catch (error) {
    console.error(error);
    await env.stop();
    process.exit(1);
  }
  await new Promise(() => {});
}

async function doctor() {
  const runDir = runDirArg();
  const rows: [boolean, string, string][] = [];
  let s: Session;
  try {
    s = loadSession(runDir);
    rows.push([true, "session", rel(join(runDir, "session.json"))]);
  } catch (e) {
    console.log(`✗ session      ${(e as Error).message}`);
    process.exit(1);
  }
  rows.push([alive(s.pid), "process", `serve pid ${s.pid} ${alive(s.pid) ? "alive" : "is gone"}`]);
  const [uiPort, apiPort] = [Number(new URL(s.ui).port), Number(new URL(s.api).port)];
  const ours = await groupPids(s.pid);
  const owners = [...(await listenerPids(uiPort)), ...(await listenerPids(apiPort))];
  const owned = owners.length >= 2 && owners.every((p) => ours.includes(p));
  rows.push([owned, "ports", owned ? `UI ${uiPort} and API ${apiPort} are served by this run` : `listeners ${owners.join(", ") || "none"} on ${uiPort}/${apiPort} are not all in process group ${s.pid}`]);
  try {
    const h = (await (await fetch(`${s.ui}/api/__qa/health`)).json()) as { qa?: boolean; jev?: string; fastRetries?: boolean };
    rows.push([!!h.qa, "qa worker", h.qa ? `fixture edges, jev=${h.jev}, fastRetries=${h.fastRetries}` : "health route missing: this is not the QA Worker"]);
  } catch (e) {
    rows.push([false, "qa worker", `${s.ui}/api/__qa/health unreachable (${(e as Error).message})`]);
  }
  try {
    const anon = (await fetch(`${s.ui}/api/library`)).status;
    const r = await fetch(`${s.ui}/api/library`, { headers: { Cookie: s.accounts[0]!.cookie } });
    const links = r.ok ? ((await r.json()) as { links: unknown[] }).links.length : 0;
    rows.push([anon === 401 && r.status === 200, "auth", `anonymous ${anon}, ${s.accounts[0]!.email} ${r.status}${r.ok ? ` (${links} links)` : ""}`]);
  } catch (e) {
    rows.push([false, "auth", (e as Error).message]);
  }
  const stale = newestSource(s.startedAt);
  rows.push([!stale, "code", stale ? `${rel(stale.path)} changed after launch: run down, then up` : `no source edits since launch (${s.commit})`]);
  for (const [ok, name, detail] of rows) console.log(`${ok ? "✓" : "✗"} ${name.padEnd(12)} ${detail}`);
  console.log(`  ui           ${s.ui}`);
  process.exit(rows.every(([ok]) => ok) ? 0 : 1);
}

async function down() {
  const runDir = runDirArg();
  if (existsSync(join(runDir, "session.json"))) {
    const s = loadSession(runDir);
    // SIGTERM lets serve stop the stack its own way first; the group sweep catches anything that outlived it.
    if (alive(s.pid)) {
      process.kill(s.pid, "SIGTERM");
      for (let i = 0; i < 100 && alive(s.pid); i++) await Bun.sleep(200);
    }
    await stopGroup(s.pid);
    const ports = [Number(new URL(s.ui).port), Number(new URL(s.api).port)];
    const left = (await Promise.all(ports.map(listenerPids))).flat();
    if (left.length) console.error(`Still listening on ${ports.join("/")}: pids ${left.join(", ")} (outside this run's process group; left alone).`);
  }
  // Instance state holds live session tokens and sign-in links; evidence and logs stay.
  for (const name of readdirSync(runDir)) if (!["evidence", "logs"].includes(name)) rmSync(join(runDir, name), { recursive: true, force: true });
  if (existsSync(POINTER) && resolve(ROOT, readFileSync(POINTER, "utf8").trim()) === runDir) rmSync(POINTER);
  const evidence = join(runDir, "evidence");
  console.log(`Down. Kept: ${rel(join(runDir, "logs"))}${existsSync(evidence) ? `, ${rel(evidence)} (${readdirSync(evidence).length} journey runs)` : ""}`);
}

async function run() {
  const file = args[1];
  if (!file || !existsSync(resolve(file))) throw new Error("Usage: verify.ts run <journey.ts> [--run DIR] [--headed]");
  const s = loadSession();
  const stale = newestSource(s.startedAt);
  if (stale) throw new Error(`${rel(stale.path)} changed after launch; the instance runs older code. Run down, then up.`);
  const { runJourney } = await import("./journey");
  const dir = join(s.runDir, "evidence", `${basename(file, ".ts")}-${stamp()}`);
  const report = await runJourney(resolve(file), s, dir, { headed: flag("--headed") });
  for (const c of report.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.error ? ` — ${c.error}` : ""}`);
  console.log(`${report.status.toUpperCase()}: ${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks${report.error ? ` — ${report.error}` : ""}\nevidence: ${rel(dir)}`);
  process.exit(report.status === "passed" ? 0 : 1);
}

if (import.meta.main) {
  const commands: Record<string, () => Promise<void>> = { up, serve, doctor, down, run };
  const command = commands[args[0] ?? ""];
  if (!command) {
    console.error("Usage: verify.ts up | doctor | run <journey.ts> | down   (see the header of this file)");
    process.exit(2);
  }
  await command().catch((e) => {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  });
}
