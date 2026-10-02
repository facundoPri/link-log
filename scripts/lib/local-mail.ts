// Reads auth emails captured by `wrangler dev`'s local send_email simulation
// (.wrangler/tmp/email/<session>/email-text/*.txt). Local/test only: nothing is sent for real.
// These files contain live sign-in tokens for local state; .wrangler/ is gitignored.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".wrangler/tmp/email";
const ACTION = { verify: "Confirm email: ", magic: "Sign in: ", reset: "Choose a new password: " } as const;
export type MailKind = keyof typeof ACTION;

function textFiles() {
  const files: string[] = [];
  let sessions: string[] = [];
  try {
    sessions = readdirSync(ROOT);
  } catch {
    return files;
  }
  for (const session of sessions) {
    const dir = join(ROOT, session, "email-text");
    try {
      for (const name of readdirSync(dir)) files.push(join(dir, name));
    } catch {}
  }
  return files;
}

/** Waits for the newest matching email sent after `since` and returns the link it carries. */
export async function waitForMail(to: string, kind: MailKind, since: number, timeoutMs = 15000) {
  const marker = `Requested for ${to.toLowerCase()}.`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = textFiles()
      .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
      .filter((f) => f.mtime >= since - 1000)
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => readFileSync(f.file, "utf8"))
      .find((body) => body.includes(marker) && body.includes(ACTION[kind]));
    if (match) return match.split(ACTION[kind])[1]!.split(/\s/)[0]!;
    await Bun.sleep(150);
  }
  throw new Error(`No ${kind} email for ${to} within ${timeoutMs}ms.`);
}

/** Counts matching emails after `since` (to assert suppression without reading tokens). */
export function countMail(to: string, kind: MailKind, since: number) {
  const marker = `Requested for ${to.toLowerCase()}.`;
  return textFiles().filter((file) => {
    if (statSync(file).mtimeMs < since - 1000) return false;
    const body = readFileSync(file, "utf8");
    return body.includes(marker) && body.includes(ACTION[kind]);
  }).length;
}
