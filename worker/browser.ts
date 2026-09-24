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
  type SaveItem,
  type SaveResult,
  type TargetStatus,
} from "@linklog/browser-protocol";
import type { Lens } from "../src/types";
import { domainOf, normalizeUrl } from "../src/url";
import { json, library, parseLensDefinition, text } from "./store";

// Browser view API. Requests come from the Linklog page through the existing
// same-origin boundary; the extension never talks to the backend directly.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const idOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);

export async function libraryId(env: Env): Promise<string> {
  await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('library_id',?)")
    .bind(crypto.randomUUID())
    .run();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='library_id'").first<{ value: string }>();
  return row!.value;
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
  await Promise.all(
    targets.map((t) =>
      env.CONTENT.put(t.captureKey, t.capture.markdown, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
    ),
  );
  // D1 is the durable outbox; cron recovery resends if this dispatch fails.
  try {
    await env.JOBS.sendBatch(targets.map((t) => ({ body: { id: t.jobId } })));
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

async function saveCaptures(env: Env, body: Obj): Promise<SaveResult[]> {
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > BROWSER_LIMITS.maxSaveItems)
    throw new Error(`Save between 1 and ${BROWSER_LIMITS.maxSaveItems} tabs at a time.`);
  const results: SaveResult[] = [];
  for (const raw of body.items as unknown[]) {
    const key = isObj(raw) && typeof raw.key === "string" ? raw.key.slice(0, 100) : "";
    try {
      if (!isObj(raw)) throw new Error("Invalid tab.");
      const item: SaveItem = {
        key,
        url: text(raw.url, 4096),
        title: text(raw.title, 1000),
        favicon: faviconOf(raw.favicon),
        capture: raw.capture === undefined ? undefined : capture(raw.capture),
      };
      // Same normalization, URL rules and dedupe as saving from All links.
      const url = normalizeUrl(item.url);
      const existing = await env.DB.prepare("SELECT id FROM links WHERE original_url=? OR url=?")
        .bind(url, url)
        .first<{ id: string }>();
      if (existing) {
        results.push({ key, status: "duplicate", id: existing.id });
        continue;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO links(id,original_url,url,domain,title,description,favicon,status,created_at) SELECT ?,?,?,?,?,?,?,'ready',? WHERE NOT EXISTS(SELECT 1 FROM links WHERE original_url=? OR url=?)",
      )
        .bind(id, url, url, domainOf(url), item.title || domainOf(url), item.capture?.description ?? "", item.favicon, now, url, url)
        .run();
      if (!inserted.meta.changes) {
        const winner = await env.DB.prepare("SELECT id FROM links WHERE original_url=? OR url=?").bind(url, url).first<{ id: string }>();
        results.push({ key, status: "duplicate", id: winner?.id });
        continue;
      }
      if (item.capture && item.capture.source === "dom" && item.capture.markdown.trim()) {
        // Content read locally; saving it never triggers a remote extraction.
        const contentKey = `links/${id}/${crypto.randomUUID()}.md`;
        await env.CONTENT.put(contentKey, item.capture.markdown, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });
        const partial = item.capture.completeness === "partial";
        const details = {
          type: "web",
          completeness: partial ? "unverified" : "verified",
          issues: item.capture.reasons,
          provenance: { source: "browser-extension", capturedAt: item.capture.capturedAt, facts: item.capture.facts },
        };
        await env.DB.prepare(
          "UPDATE links SET content_key=?,content_version=1,content_source='browser',content_state=?,content_error=NULL,content_details=?,content_updated_at=? WHERE id=?",
        )
          .bind(contentKey, partial ? "partial" : "ready", JSON.stringify(details), item.capture.capturedAt, id)
          .run();
      }
      results.push({ key, status: "created", id });
    } catch (error) {
      results.push({ key, status: "rejected", error: error instanceof Error ? error.message : "Could not save." });
    }
  }
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
      // Stored in the extension: the payload can go; the receipt and usage stay.
      const rows = await env.DB.prepare(
        `SELECT id,capture_key FROM browser_targets WHERE request_id=? AND target_key IN (${keys.map(() => "?").join(",")})`,
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
    const results = await saveCaptures(env, body);
    return json({ results, ...(await library(env)) });
  }
  return null;
}
