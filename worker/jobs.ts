import { evaluationStatements } from "./ai/persist";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { extractMetadata } from "./metadata";
import { extract } from "./adapters";
import { judge, tagQuestions, queryQuestions } from "./ai/jev";
import type { Link, Tag, QueryConfig } from "../src/types";
export type JobRow = {
  id: string;
  batch_id: string;
  link_id: string;
  status: string;
};
type Config = { tags?: Tag[]; query?: QueryConfig };
export async function enqueue(
  env: Env,
  ids: string[],
  kind: "extract" | "autotag" | "query",
  config: Config = {},
) {
  ids = [...new Set(ids)];
  if (!ids.length || ids.length > 100)
    throw new Error("Seleccioná entre 1 y 100 links por lote.");
  const links = await env.DB.prepare(
    `SELECT * FROM links WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<Link>();
  if (links.results.length !== ids.length)
    throw new Error("Uno de los links ya no existe.");
  if (kind !== "extract" && links.results.some((l) => !l.content_key))
    throw new Error(
      "Todos los links seleccionados necesitan contenido primero.",
    );
  const active = await env.DB.prepare(
    `SELECT id FROM jobs WHERE status IN ('queued','running') AND link_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`,
  )
    .bind(...ids)
    .first();
  if (active)
    throw new Error("Hay links seleccionados que todavía se están procesando.");
  if (kind === "autotag") {
    const tags = await env.DB.prepare(
      "SELECT * FROM tags ORDER BY name",
    ).all<Tag>();
    if (!tags.results.length) throw new Error("Creá al menos una etiqueta.");
    config = { tags: tags.results };
  }
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const jobs = ids.map((link_id) => ({ id: crypto.randomUUID(), link_id }));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO batches(id,kind,config,created_at) VALUES(?,?,?,?)",
    ).bind(id, kind, JSON.stringify(config), now),
    ...jobs.map((j) =>
      env.DB.prepare(
        "INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES(?,?,?,?)",
      ).bind(j.id, id, j.link_id, now),
    ),
    ...(kind === "extract"
      ? ids.map((link) =>
          env.DB.prepare(
            "UPDATE links SET content_state='queued',content_error=NULL WHERE id=?",
          ).bind(link),
        )
      : []),
  ]);
  // D1 is the durable outbox. If dispatch fails, scheduled recovery resends these IDs.
  try {
    await env.JOBS.sendBatch(jobs.map((j) => ({ body: { id: j.id } })));
  } catch {
    console.error("Queue dispatch deferred to outbox recovery");
  }
  return id;
}
export async function recover(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT id FROM jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100",
  ).all<{ id: string }>();
  if (rows.results.length)
    await env.JOBS.sendBatch(rows.results.map((body) => ({ body })));
}
export async function dispatch(batch: MessageBatch<{ id: string }>, env: Env) {
  for (const m of batch.messages) {
    try {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
        .bind(m.body.id)
        .first<JobRow>();
      if (!job || ["done", "failed"].includes(job.status)) {
        m.ack();
        continue;
      }
      try {
        await env.PROCESS_LINK.create({ id: job.id, params: { id: job.id } });
      } catch (error) {
        // A redelivery must never create a second workflow or repeat its paid steps.
        const instance = await env.PROCESS_LINK.get(job.id);
        const status = await instance.status();
        if (!status) throw error;
        if (["errored", "terminated", "complete"].includes(status.status)) {
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE jobs SET status='failed',step='Interrumpido',error='El workflow se interrumpió. Volvé a intentar.',completed_at=? WHERE id=? AND status IN ('queued','running')",
            ).bind(new Date().toISOString(), job.id),
            env.DB.prepare(
              "UPDATE links SET content_state=CASE WHEN content_key IS NULL THEN 'failed' ELSE 'ready' END,content_error='El workflow se interrumpió. Volvé a intentar.' WHERE id=? AND content_state='queued'",
            ).bind(job.link_id),
            env.DB.prepare("DELETE FROM provider_leases WHERE job_id=?").bind(
              job.id,
            ),
          ]);
        }
      }
      m.ack();
    } catch {
      m.retry({ delaySeconds: 15 });
    }
  }
}
export class LinkWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    const env = this.env;
    const data = await step.do("load-job", async () => {
      const row = await env.DB.prepare(
        "SELECT j.*,b.kind,b.config FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?",
      )
        .bind(event.payload.id)
        .first<JobRow & { kind: string; config: string }>();
      if (!row) throw new Error("El trabajo ya no existe.");
      const link = await env.DB.prepare("SELECT * FROM links WHERE id=?")
        .bind(row.link_id)
        .first<Link>();
      if (!link) throw new Error("El link ya no existe.");
      await env.DB.prepare(
        "UPDATE jobs SET status='running',step='Preparando contenido' WHERE id=?",
      )
        .bind(row.id)
        .run();
      return { job: row, link };
    });
    const { job, link } = data;
    try {
      let lease = false;
      for (let attempt = 0; !lease; attempt++) {
        lease = await step.do(`provider-slot-${attempt}`, async () => {
          const now = Date.now();
          await env.DB.prepare("DELETE FROM provider_leases WHERE expires_at<?")
            .bind(now)
            .run();
          const result = await env.DB.prepare(
            "INSERT OR IGNORE INTO provider_leases(job_id,expires_at) SELECT ?,? WHERE (SELECT count(*) FROM provider_leases)<2",
          )
            .bind(job.id, now + 300000)
            .run();
          return (
            result.meta.changes > 0 ||
            !!(await env.DB.prepare(
              "SELECT job_id FROM provider_leases WHERE job_id=?",
            )
              .bind(job.id)
              .first())
          );
        });
        if (!lease)
          await step.sleep(`waiting-for-slot-${attempt}`, "10 seconds");
      }
      if (job.kind === "extract") {
        const metadata = await step.do(
          "resolve-and-preview",
          { retries: { limit: 1, delay: "2 seconds", backoff: "constant" } },
          () => extractMetadata(link.original_url),
        );
        await step.do("save-preview", async () => {
          await env.DB.prepare(
            "UPDATE links SET url=?,domain=?,title=?,description=?,image=?,favicon=?,status=? WHERE id=?",
          )
            .bind(
              metadata.url,
              metadata.domain,
              metadata.title,
              metadata.description,
              metadata.image,
              metadata.favicon,
              metadata.status,
              link.id,
            )
            .run();
          await env.DB.prepare(
            "UPDATE jobs SET step='Extrayendo contenido' WHERE id=?",
          )
            .bind(job.id)
            .run();
        });
        // Store large content in R2 inside the provider step, return only its pointer to the workflow log.
        const content = await step.do(
          "extract-content",
          { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          async () => {
            const result = await extract(env, metadata.url, job);
            if (new TextEncoder().encode(result.markdown).length > 2000000)
              throw new Error(
                "El contenido supera 2 MB. Podés cargar una versión manual.",
              );
            const key = `links/${link.id}/${job.id}.md`;
            await env.CONTENT.put(key, result.markdown, {
              httpMetadata: { contentType: "text/markdown; charset=utf-8" },
            });
            return { key, source: result.source };
          },
        );
        await step.do("save-content", async () => {
          await env.DB.prepare(
            "UPDATE links SET content_key=?,content_version=content_version+1,content_source=?,content_state='ready',content_error=NULL,content_updated_at=? WHERE id=?",
          )
            .bind(
              content.key,
              content.source,
              new Date().toISOString(),
              link.id,
            )
            .run();
        });
      } else {
        const config = JSON.parse(job.config) as Config;
        const result = await step.do(
          "evaluate-jev",
          { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          async () => {
            await env.DB.prepare(
              "UPDATE jobs SET step='Evaluando con Jev' WHERE id=?",
            )
              .bind(job.id)
              .run();
            const object = await env.CONTENT.get(link.content_key!);
            if (!object)
              throw new Error(
                "Falta el contenido guardado. Volvé a extraerlo.",
              );
            return judge(
              env,
              {
                url: link.url,
                title: link.title,
                content: await object.text(),
              },
              job.kind === "autotag"
                ? tagQuestions(config.tags!)
                : queryQuestions(config.query!),
              job,
            );
          },
        );
        await step.do("save-evaluation", async () => {
          const now = new Date().toISOString();
          const statements: D1PreparedStatement[] = [];
          if (job.kind === "autotag")
            statements.push(
              ...evaluationStatements(
                env.DB,
                link,
                config.tags!,
                result.answers,
                result.model,
                job.batch_id,
                now,
              ),
            );
          statements.push(
            env.DB.prepare("UPDATE jobs SET result=? WHERE id=?").bind(
              JSON.stringify(result),
              job.id,
            ),
          );
          await env.DB.batch(statements);
        });
      }
      await step.do("complete", async () => {
        await env.DB.prepare(
          "UPDATE jobs SET status='done',step='Listo',completed_at=? WHERE id=?",
        )
          .bind(new Date().toISOString(), job.id)
          .run();
      });
    } catch (error) {
      await step.do("record-failure", async () => {
        const message =
          error instanceof Error ? error.message : "No se pudo procesar";
        await env.DB.prepare(
          "UPDATE jobs SET status='failed',step='Necesita atención',error=?,completed_at=? WHERE id=?",
        )
          .bind(message, new Date().toISOString(), job.id)
          .run();
        if (job.kind === "extract")
          await env.DB.prepare(
            "UPDATE links SET content_state=CASE WHEN content_key IS NULL THEN 'failed' ELSE 'ready' END,content_error=?,status=CASE WHEN status='pending' THEN 'failed' ELSE status END WHERE id=?",
          )
            .bind(message, link.id)
            .run();
      });
    } finally {
      await step.do("release-provider-slot", async () => {
        await env.DB.prepare("DELETE FROM provider_leases WHERE job_id=?")
          .bind(job.id)
          .run();
      });
    }
  }
}
