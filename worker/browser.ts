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
import { enqueue } from "./jobs";
import { addLink } from "./links";
import { json, library, parseLensDefinition, text } from "./store";

// Browser view API. Requests come from the Linklog page through the existing
// same-origin boundary; the extension never talks to the backend directly.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const idOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);

const readLibraryId = (env: Env) =>
  env.DB.prepare("SELECT value FROM settings WHERE key='library_id'").first<{ value: string }>();

/** Stable id of this library; created once, then only read (GET routes never write). */
export async function libraryId(env: Env): Promise<string> {
  const existing = await readLibraryId(env);
  if (existing) return existing.value;
  await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('library_id',?)")
    .bind(crypto.randomUUID())
    .run();
  return (await readLibraryId(env))!.value;
}

function retentionDays(env: Env) {
  const days = Number(env.BROWSER_RESULT_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

async function catalog(env: Env): Promise<BrowserCatalog> {
  const [id, groups] = await Promise.all([
    libraryId(env),
    env.DB.prepare("SELECT * FROM browser_groups ORDER BY name COLLATE NOCASE, created_at").all<PinnedGroup>(),
  ]);
  return { libraryId: id, groups: groups.results, retentionDays: retentionDays(env) };
}

function capture(v: unknown): EvaluationCapture {
  if (!isObj(v)) throw new Error("Invalid capture.");
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
    throw new Error("Invalid capture.");
  if (v.markdown.length > BROWSER_LIMITS.maxCaptureChars)
    throw new Error(`A capture exceeds ${BROWSER_LIMITS.maxCaptureChars.toLocaleString("en")} characters; the extension must trim it and mark it partial.`);
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
    throw new Error("Invalid evaluation request.");
  if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > BROWSER_LIMITS.maxTargets)
    throw new Error(`Send between 1 and ${BROWSER_LIMITS.maxTargets} tabs per request.`);
  const seen = new Set<string>();
  // URLs are stored as data only; this route never fetches them.
  const targets = body.targets.map((t) => {
    if (!isObj(t) || typeof t.targetKey !== "string" || !t.targetKey || t.targetKey.length > 400 || seen.has(t.targetKey))
      throw new Error("Invalid target.");
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
    if (!isObj(body.lens) || !idOk(body.lens.id) || !idOk(body.lens.fingerprint)) throw new Error("Pick a lens.");
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
      throw new Error(`Autogroup needs between 1 and ${BROWSER_LIMITS.maxDestinations} groups.`);
    const keys = new Set<string>();
    const destinations: Destination[] = body.destinations.map((d) => {
      if (!isObj(d) || typeof d.key !== "string" || !/^[A-Za-z0-9:_-]{1,80}$/.test(d.key) || keys.has(d.key))
        throw new Error("Invalid group.");
      keys.add(d.key);
      return { key: d.key, name: text(d.name, 80), description: text(d.description ?? "", 2000) };
    });
    return { ...base, kind: "autogroup", destinations, catalogVersion: body.catalogVersion };
  }
  throw new Error("Invalid evaluation kind.");
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

export async function evaluationStatus(env: Env, requestId: string): Promise<EvaluationStatus | null> {
  const request = await env.DB.prepare("SELECT request_id,batch_id,kind FROM browser_requests WHERE request_id=?")
    .bind(requestId)
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

async function createEvaluation(env: Env, body: Obj): Promise<Response> {
  const req = evaluationRequest(body);
  const ours = await libraryId(env);
  if (req.libraryId !== ours)
    return json({ error: "This page belongs to a different library. Reload Linklog.", code: "library-mismatch" }, 409);
  const hash = await sha256(JSON.stringify(req));
  const existing = await env.DB.prepare("SELECT payload_hash FROM browser_requests WHERE request_id=?")
    .bind(req.requestId)
    .first<{ payload_hash: string }>();
  if (existing) {
    // Same key and payload → same work. Same key, different payload → conflict.
    if (existing.payload_hash !== hash)
      return json({ error: "This request ID was already used with different content.", code: "conflict" }, 409);
    return json(await evaluationStatus(env, req.requestId));
  }
  let lens: Lens, config: Record<string, unknown>, kind: string;
  if (req.kind === "lens") {
    const row = await env.DB.prepare("SELECT * FROM lenses WHERE id=?").bind(req.lens.id).first<Record<string, unknown>>();
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
  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();
  const targets = req.targets.map((t) => ({
    ...t,
    id: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    captureKey: `browser/${req.requestId}/${crypto.randomUUID()}.md`,
  }));
  try {
    // One transaction: the request row is the idempotency receipt. A concurrent
    // duplicate violates its primary key and rolls everything back.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO batches(id,kind,config,created_at) VALUES(?,?,?,?)").bind(batchId, kind, JSON.stringify(config), now),
      env.DB.prepare(
        "INSERT INTO browser_requests(request_id,payload_hash,kind,batch_id,library_id,session_id,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(req.requestId, hash, req.kind, batchId, req.libraryId, req.sessionId, now),
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
    const again = await env.DB.prepare("SELECT payload_hash FROM browser_requests WHERE request_id=?")
      .bind(req.requestId)
      .first<{ payload_hash: string }>();
    if (!again) throw error;
    if (again.payload_hash !== hash)
      return json({ error: "This request ID was already used with different content.", code: "conflict" }, 409);
    return json(await evaluationStatus(env, req.requestId));
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
  return json(await evaluationStatus(env, req.requestId), 201);
}

function color(v: unknown): GroupColor {
  if (typeof v !== "string" || !(GROUP_COLORS as string[]).includes(v)) throw new Error("Pick a group color.");
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
async function saveUrls(env: Env, body: Obj): Promise<SaveResult[]> {
  if (
    !Array.isArray(body.urls) ||
    !body.urls.length ||
    body.urls.length > BROWSER_LIMITS.maxSaveItems ||
    body.urls.some((u) => typeof u !== "string")
  )
    throw new Error(`Save between 1 and ${BROWSER_LIMITS.maxSaveItems} tabs at a time.`);
  const results: SaveResult[] = [];
  for (const url of body.urls as string[]) {
    try {
      const { id, created } = await addLink(env, url);
      results.push({ url, status: created ? "created" : "duplicate", id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      results.push({ url, status: "rejected", error: /D1_|SQLITE/i.test(message) ? "Could not save." : message || "Could not save." });
    }
  }
  // One extraction batch per request, like an import.
  const created = [...new Set(results.filter((r) => r.status === "created").map((r) => r.id!))];
  if (created.length) await enqueue(env, created, "extract");
  return results;
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

export async function browserRoute(
  env: Env,
  path: string,
  method: string,
  body: Obj,
): Promise<Response | null> {
  if (path === "/api/browser/catalog" && method === "GET") return json(await catalog(env));
  if (path === "/api/browser/evaluations" && method === "POST") return createEvaluation(env, body);
  const evaluation = path.match(/^\/api\/browser\/evaluations\/([A-Za-z0-9_-]{1,80})(\/ack)?$/);
  if (evaluation) {
    const requestId = evaluation[1]!;
    if (!evaluation[2] && method === "GET") {
      const status = await evaluationStatus(env, requestId);
      return status ? json(status) : json({ error: "Unknown request.", code: "unknown-request" }, 404);
    }
    const keys =
      Array.isArray(body.targetKeys) && body.targetKeys.every((k) => typeof k === "string" && k.length <= 400)
        ? (body.targetKeys as string[]).slice(0, BROWSER_LIMITS.maxTargets)
        : null;
    if (evaluation[2] && method === "POST") {
      if (!keys?.length) throw new Error("Nothing to confirm.");
      // Stored in the extension: the payload can go; the receipt and usage stay. Only
      // answered targets are confirmed; the rest keep their snapshot until retention.
      const rows = await env.DB.prepare(
        `SELECT id,capture_key FROM browser_targets WHERE request_id=? AND answer IS NOT NULL AND target_key IN (${keys.map(() => "?").join(",")})`,
      )
        .bind(requestId, ...keys)
        .all<{ id: string; capture_key: string | null }>();
      const captureKeys = rows.results.map((r) => r.capture_key).filter((k): k is string => !!k);
      if (captureKeys.length) await env.CONTENT.delete(captureKeys);
      await env.DB.prepare(
        `UPDATE browser_targets SET acked_at=coalesce(acked_at,?),answer=NULL,capture_key=NULL WHERE request_id=? AND answer IS NOT NULL AND target_key IN (${keys.map(() => "?").join(",")})`,
      )
        .bind(new Date().toISOString(), requestId, ...keys)
        .run();
      return json({ acked: rows.results.length });
    }
    if (!evaluation[2] && method === "DELETE") {
      // Clean, close or navigation: cancel work that has not started. A call already
      // sent to the provider may still be billed and stays in Activity.
      const filter = keys?.length ? ` AND target_key IN (${keys.map(() => "?").join(",")})` : "";
      const result = await env.DB.prepare(
        `UPDATE jobs SET status='failed',step='Cancelled',error='Cancelled',completed_at=? WHERE status='queued' AND target_id IN (SELECT id FROM browser_targets WHERE request_id=?${filter})`,
      )
        .bind(new Date().toISOString(), requestId, ...(keys ?? []))
        .run();
      return json({ cancelled: result.meta.changes });
    }
    return json({ error: "Method not allowed." }, 405);
  }
  if (path === "/api/browser/groups" && method === "POST") {
    const name = text(body.name, 80);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO browser_groups(id,name,description,color,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(typeof body.id === "string" && idOk(body.id) ? body.id : crypto.randomUUID(), name, text(body.description ?? "", 2000), color(body.color), now, now)
      .run();
    return json(await catalog(env), 201);
  }
  const group = path.match(/^\/api\/browser\/groups\/([A-Za-z0-9_-]{1,80})$/);
  if (group) {
    const current = await env.DB.prepare("SELECT * FROM browser_groups WHERE id=?").bind(group[1]).first<PinnedGroup>();
    if (method === "DELETE") {
      // Unpin: future destinations disappear; native groups and local metadata stay.
      await env.DB.prepare("DELETE FROM browser_groups WHERE id=?").bind(group[1]).run();
      return json(await catalog(env));
    }
    if (method === "PATCH") {
      if (!current) return json({ error: "The pinned group no longer exists." }, 404);
      await env.DB.prepare(
        "UPDATE browser_groups SET name=?,description=?,color=?,version=version+1,updated_at=? WHERE id=?",
      )
        .bind(
          body.name === undefined ? current.name : text(body.name, 80),
          body.description === undefined ? current.description : text(body.description, 2000),
          body.color === undefined ? current.color : color(body.color),
          new Date().toISOString(),
          current.id,
        )
        .run();
      return json(await catalog(env));
    }
    return json({ error: "Method not allowed." }, 405);
  }
  if (path === "/api/browser/save" && method === "POST") {
    const results = await saveUrls(env, body);
    return json({ results, ...(await library(env)) });
  }
  return null;
}
