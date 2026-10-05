import {
  BROWSER_LIMITS,
  GROUP_COLORS,
  lensFingerprint,
  type BrowserCatalog,
  type Destination,
  type EvaluationCapture,
  type EvaluationRequest,
  type EvaluationStatus,
  type GroupColor,
  type PinnedGroup,
  type SaveResult,
  type TargetStatus,
} from "@linklog/browser-protocol";
import type { Lens } from "../src/types";
import { charge, LIMITS } from "./limits";
import { addLinks } from "./links";
import { json, parseLensDefinition, text } from "./store";
import { badRequest } from "./http/context";

// Browser view API. Requests come from the signed-in Linklog page through the same-origin
// boundary; the extension never talks to the backend directly. Every read and write is scoped
// to the session owner (routes in worker/routes/browser.ts run behind requireSession).

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
export const idOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);

const readLibraryId = (env: Env, userId: string) =>
  env.DB.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='library_id'")
    .bind(userId)
    .first<{ value: string }>();

/**
 * Stable id of this user's library; created once, then only read. The extension scopes its local
 * results by it, so another account in the same browser never sees this user's results.
 */
export async function libraryId(env: Env, userId: string): Promise<string> {
  const existing = await readLibraryId(env, userId);
  if (existing) return existing.value;
  await env.DB.prepare("INSERT OR IGNORE INTO user_settings(user_id,key,value,updated_at) VALUES(?,'library_id',?,?)")
    .bind(userId, crypto.randomUUID(), new Date().toISOString())
    .run();
  return (await readLibraryId(env, userId))!.value;
}

function retentionDays(env: Env) {
  const days = Number(env.BROWSER_RESULT_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

export async function catalog(env: Env, userId: string): Promise<BrowserCatalog> {
  const [id, groups] = await Promise.all([
    libraryId(env, userId),
    env.DB.prepare("SELECT id,name,description,color,version,created_at,updated_at FROM browser_groups WHERE user_id=? ORDER BY name COLLATE NOCASE, created_at")
      .bind(userId)
      .all<PinnedGroup>(),
  ]);
  return { libraryId: id, groups: groups.results, retentionDays: retentionDays(env) };
}

function capture(v: unknown): EvaluationCapture {
  if (!isObj(v)) throw badRequest("Invalid capture.");
  const strings = (a: unknown, max: number, len: number) =>
    Array.isArray(a) && a.length <= max && a.every((s) => typeof s === "string" && s.length <= len);
  if (
    (v.source !== "dom" && v.source !== "metadata") ||
    (v.completeness !== "complete" && v.completeness !== "partial") ||
    typeof v.capturedAt !== "string" ||
    Number.isNaN(Date.parse(v.capturedAt)) ||
    !strings(v.reasons, 20, 300) ||
    !Array.isArray(v.facts) ||
    v.facts.length > 20 ||
    !v.facts.every((f) => isObj(f) && [f.key, f.label, f.value].every((s) => typeof s === "string" && s.length <= 200)) ||
    typeof v.markdown !== "string"
  )
    throw badRequest("Invalid capture.");
  if (v.markdown.length > BROWSER_LIMITS.maxCaptureChars)
    throw badRequest(`A capture exceeds ${BROWSER_LIMITS.maxCaptureChars.toLocaleString("en")} characters; the extension must trim it and mark it partial.`);
  return {
    source: v.source,
    completeness: v.completeness,
    capturedAt: v.capturedAt,
    reasons: v.reasons as string[],
    facts: (v.facts as Obj[]).map((f) => ({ key: String(f.key), label: String(f.label), value: String(f.value) })),
    description: v.description === undefined ? "" : text(v.description, 2000),
    siteName: v.siteName === undefined ? "" : text(v.siteName, 200),
    markdown: v.markdown,
  };
}

function evaluationRequest(body: Obj): EvaluationRequest {
  if (!idOk(body.requestId) || !idOk(body.libraryId) || !idOk(body.sessionId))
    throw badRequest("Invalid evaluation request.");
  if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > BROWSER_LIMITS.maxTargets)
    throw badRequest(`Send between 1 and ${BROWSER_LIMITS.maxTargets} tabs per request.`);
  const seen = new Set<string>();
  // URLs are stored as data only; this route never fetches them.
  const targets = body.targets.map((t) => {
    if (!isObj(t) || typeof t.targetKey !== "string" || !t.targetKey || t.targetKey.length > 400 || seen.has(t.targetKey))
      throw badRequest("Invalid target.");
    seen.add(t.targetKey);
    return {
      targetKey: t.targetKey,
      url: text(t.url, 4096),
      title: text(t.title, 1000),
      capture: capture(t.capture),
    };
  });
  const base = { requestId: body.requestId, libraryId: body.libraryId, sessionId: body.sessionId, targets };
  if (body.kind === "lens") {
    if (!isObj(body.lens) || !idOk(body.lens.id) || !idOk(body.lens.fingerprint)) throw badRequest("Pick a lens.");
    return { ...base, kind: "lens", lens: { id: body.lens.id, fingerprint: body.lens.fingerprint } };
  }
  if (body.kind === "autogroup") {
    if (
      !Array.isArray(body.destinations) ||
      !body.destinations.length ||
      body.destinations.length > BROWSER_LIMITS.maxDestinations ||
      typeof body.catalogVersion !== "string" ||
      body.catalogVersion.length > 100
    )
      throw badRequest(`Autogroup needs between 1 and ${BROWSER_LIMITS.maxDestinations} groups.`);
    const keys = new Set<string>();
    const destinations: Destination[] = body.destinations.map((d) => {
      if (!isObj(d) || typeof d.key !== "string" || !/^[A-Za-z0-9:_-]{1,80}$/.test(d.key) || keys.has(d.key))
        throw badRequest("Invalid group.");
      keys.add(d.key);
      return { key: d.key, name: text(d.name, 80), description: text(d.description ?? "", 2000) };
    });
    return { ...base, kind: "autogroup", destinations, catalogVersion: body.catalogVersion };
  }
  throw badRequest("Invalid evaluation kind.");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function autogroupLens(destinations: Destination[]): { lens: Lens; map: Record<string, string> } {
  const map: Record<string, string> = { other: "none" };
  const options = destinations.map((d, i) => {
    map[`g${i}`] = d.key;
    return { key: `g${i}`, label: d.name || "Unnamed group", description: d.description };
  });
  options.push({ key: "other", label: "Don't group", description: "No group clearly fits this tab." });
  return {
    map,
    lens: {
      id: "autogroup",
      name: "Autogroup",
      type: "choice",
      scope: "browser",
      question:
        "Which tab group does this browser tab belong in, judging by each group's name and description? Choose \"Don't group\" unless one clearly fits.",
      options,
      levels: [],
      criteria: { yes: "", no: "" },
      threshold: 0.5,
      version: 1,
      created_at: new Date(0).toISOString(),
    },
  };
}

export async function evaluationStatus(env: Env, userId: string, requestId: string): Promise<EvaluationStatus | null> {
  const request = await env.DB.prepare("SELECT request_id,batch_id,kind FROM browser_requests WHERE request_id=? AND user_id=?")
    .bind(requestId, userId)
    .first<{ request_id: string; batch_id: string; kind: "lens" | "autogroup" }>();
  if (!request) return null;
  const rows = await env.DB.prepare(
    "SELECT bt.target_key,bt.answer,bt.model,bt.evaluated_at,bt.acked_at,bt.expired_at,j.id job_id,j.status,j.error FROM browser_targets bt JOIN jobs j ON j.target_id=bt.id WHERE bt.request_id=? ORDER BY bt.created_at,bt.target_key",
  )
    .bind(requestId)
    .all<{
      target_key: string;
      answer: string | null;
      model: string | null;
      evaluated_at: string | null;
      acked_at: string | null;
      expired_at: string | null;
      job_id: string;
      status: "queued" | "running" | "done" | "failed";
      error: string | null;
    }>();
  const targets: TargetStatus[] = rows.results.map((r) => {
    const base = { targetKey: r.target_key, jobId: r.job_id };
    if (r.expired_at)
      return { ...base, state: "expired", error: "The result expired before this browser stored it. Evaluate again explicitly." };
    if (r.acked_at) return { ...base, state: "acked" };
    if (r.status === "done" && r.answer)
      return { ...base, state: "done", answer: JSON.parse(r.answer), model: r.model ?? undefined, evaluatedAt: r.evaluated_at ?? undefined };
    if (r.status === "failed") return { ...base, state: "failed", error: r.error ?? "The evaluation failed." };
    return { ...base, state: r.status === "done" ? "running" : r.status };
  });
  return { requestId, batchId: request.batch_id, kind: request.kind, targets };
}

export async function createEvaluation(env: Env, userId: string, body: Obj): Promise<Response> {
  const req = evaluationRequest(body);
  const ours = await libraryId(env, userId);
  if (req.libraryId !== ours)
    return json({ error: "This page belongs to a different library. Reload Linklog.", code: "library-mismatch" }, 409);
  const hash = await sha256(JSON.stringify(req));
  const receipt = () =>
    env.DB.prepare("SELECT payload_hash,user_id FROM browser_requests WHERE request_id=?")
      .bind(req.requestId)
      .first<{ payload_hash: string; user_id: string | null }>();
  const replay = async (found: { payload_hash: string; user_id: string | null }) =>
    // Same key and payload from the same owner -> same work. Anything else -> conflict, without
    // revealing whose request it was.
    found.user_id !== userId || found.payload_hash !== hash
      ? json({ error: "This request ID was already used with different content.", code: "conflict" }, 409)
      : json(await evaluationStatus(env, userId, req.requestId));
  const existing = await receipt();
  if (existing) return replay(existing);
  let lens: Lens, config: Record<string, unknown>, kind: string;
  if (req.kind === "lens") {
    const row = await env.DB.prepare("SELECT id,name,type,question,options,threshold,version,created_at,scope FROM lenses WHERE id=? AND user_id=?")
      .bind(req.lens.id, userId)
      .first<Record<string, unknown>>();
    if (!row) return json({ error: "The lens no longer exists.", code: "lens-missing" }, 404);
    // Library lenses keep their own results in All links; only browser lenses run here.
    if (row.scope !== "browser")
      return json({ error: "Only browser lenses can evaluate open tabs.", code: "lens-scope" }, 400);
    lens = { ...(row as unknown as Lens), ...parseLensDefinition(row.type as Lens["type"], String(row.options)) };
    if (lensFingerprint(lens) !== req.lens.fingerprint)
      return json({ error: "The lens changed. Refresh to evaluate with the current question.", code: "lens-changed" }, 409);
    config = { lens, browser: true };
    kind = "browser-lens";
  } else {
    const built = autogroupLens(req.destinations);
    lens = built.lens;
    config = { lens, destinations: built.map, catalogVersion: req.catalogVersion, browser: true };
    kind = "browser-autogroup";
  }
  // Browser evaluations share the owner's job quota with the library; it is taken before any
  // receipt, snapshot or queue message exists, and only a new request is charged.
  const charged = await charge(env.DB, [{ key: `jobs:${userId}`, limit: LIMITS.jobsPerUser, cost: req.targets.length }]);
  if (!charged) return json({ error: "Processing limit reached. Try again later.", code: "rate-limited" }, 429);
  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();
  const targets = req.targets.map((t) => ({
    ...t,
    id: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    captureKey: `users/${userId}/browser/${req.requestId}/${crypto.randomUUID()}.md`,
  }));
  try {
    // One transaction: the request row is the idempotency receipt. A concurrent
    // duplicate violates its primary key and rolls everything back.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO batches(id,user_id,kind,config,created_at) VALUES(?,?,?,?,?)").bind(batchId, userId, kind, JSON.stringify(config), now),
      env.DB.prepare(
        "INSERT INTO browser_requests(request_id,user_id,payload_hash,kind,batch_id,library_id,session_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(req.requestId, userId, hash, req.kind, batchId, req.libraryId, req.sessionId, now),
      ...targets.flatMap((t) => {
        const { markdown: _markdown, ...meta } = t.capture;
        return [
          env.DB.prepare(
            "INSERT INTO browser_targets(id,request_id,target_key,url,title,capture_key,capture_meta,created_at) VALUES(?,?,?,?,?,?,?,?)",
          ).bind(t.id, req.requestId, t.targetKey, t.url, t.title, t.captureKey, JSON.stringify(meta), now),
          env.DB.prepare("INSERT INTO jobs(id,batch_id,target_id,created_at) VALUES(?,?,?,?)").bind(t.jobId, batchId, t.id, now),
        ];
      }),
    ]);
  } catch (error) {
    // Nothing was created: a concurrent duplicate won (or the write failed).
    await charged.release();
    const again = await receipt();
    if (!again) throw error;
    return replay(again);
  }
  // Snapshots are written after the receipt so a duplicate can never overwrite them.
  const stored = await Promise.allSettled(
    targets.map((t) =>
      env.CONTENT.put(t.captureKey, t.capture.markdown, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
    ),
  );
  const lost = targets.filter((_, i) => stored[i]!.status === "rejected");
  if (lost.length) {
    // Never leave a receipt whose jobs can't run: those targets fail visibly (no provider
    // call was made) and the user can evaluate them again explicitly.
    console.error(`Could not store ${lost.length} browser snapshot(s)`);
    await charged.release(lost.length); // those jobs never reach a provider
    await env.DB.batch(
      lost.map((t) =>
        env.DB.prepare(
          "UPDATE jobs SET status='failed',step='Failed',error=?,completed_at=? WHERE id=? AND status='queued'",
        ).bind("The page snapshot could not be stored. Evaluate the tab again.", new Date().toISOString(), t.jobId),
      ),
    );
  }
  const ready = targets.filter((t) => !lost.includes(t));
  // D1 is the durable outbox; cron recovery resends if this dispatch fails.
  try {
    if (ready.length) await env.JOBS.sendBatch(ready.map((t) => ({ body: { id: t.jobId } })));
  } catch {
    console.error("Queue dispatch deferred to outbox recovery");
  }
  return json(await evaluationStatus(env, userId, req.requestId), 201);
}

export function color(v: unknown): GroupColor {
  if (typeof v !== "string" || !(GROUP_COLORS as string[]).includes(v)) throw badRequest("Pick a group color.");
  return v as GroupColor;
}

function faviconOf(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Save from Browser = adding the links in All links: same normalization, URL rules,
 * dedupe and the normal server pipeline (metadata, content extraction, autotag). Only
 * URLs are sent; nothing read locally becomes library content.
 */
export async function saveUrls(env: Env, userId: string, body: Obj): Promise<SaveResult[]> {
  if (
    !Array.isArray(body.urls) ||
    !body.urls.length ||
    body.urls.length > BROWSER_LIMITS.maxSaveItems ||
    body.urls.some((u) => typeof u !== "string")
  )
    throw badRequest(`Save between 1 and ${BROWSER_LIMITS.maxSaveItems} tabs at a time.`);
  // One extraction batch per request, like an import; quotas admitted before anything is saved.
  const results = await addLinks(env, userId, body.urls as string[]);
  return results.map((r) =>
    "error" in r
      ? { url: r.input, status: "rejected", error: r.error }
      : { url: r.input, status: r.created ? "created" : "duplicate", id: r.id },
  );
}

/** Idempotent retention sweep; safe to run from cron or recovery. */
export async function cleanupBrowser(env: Env, now = Date.now()) {
  const days = retentionDays(env);
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  // Snapshots of finished jobs are no longer needed.
  const finished = await env.DB.prepare(
    "SELECT bt.id,bt.capture_key FROM browser_targets bt JOIN jobs j ON j.target_id=bt.id WHERE bt.capture_key IS NOT NULL AND j.status IN ('done','failed') LIMIT 200",
  ).all<{ id: string; capture_key: string }>();
  // Results never confirmed by the extension expire after the retention window.
  const stale = await env.DB.prepare(
    "SELECT id,capture_key FROM browser_targets WHERE acked_at IS NULL AND expired_at IS NULL AND created_at<? LIMIT 200",
  )
    .bind(cutoff)
    .all<{ id: string; capture_key: string | null }>();
  const keys = [...finished.results, ...stale.results].map((r) => r.capture_key).filter((k): k is string => !!k);
  if (keys.length) await env.CONTENT.delete(keys);
  const statements: D1PreparedStatement[] = [
    ...finished.results.map((r) => env.DB.prepare("UPDATE browser_targets SET capture_key=NULL WHERE id=?").bind(r.id)),
    ...stale.results.map((r) =>
      env.DB.prepare("UPDATE browser_targets SET capture_key=NULL,answer=NULL,expired_at=? WHERE id=?").bind(new Date(now).toISOString(), r.id),
    ),
  ];
  if (statements.length) await env.DB.batch(statements);
  return { snapshots: finished.results.length, expired: stale.results.length };
}
