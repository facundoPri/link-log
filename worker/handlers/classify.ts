import { JevFailure, tagQuestions, lensQuestions, lensAnswer } from "../ai/jev";
import { evaluateWithJev, readSaved } from "./jev-step";
import { evaluationStatements } from "../ai/persist";
import type { JobHandler } from "./index";
import { jobRunning } from "../attention";

export const classifyHandler: JobHandler = {
  pool: () => "jev",
  async run({ env, step, job, link, config }) {
    const result = await evaluateWithJev(env, step, job, async () => {
      if (job.kind !== "autotag" && !config.lens)
        throw new JevFailure("before_call", "before_call", "This job predates lenses; it can't be run.");
      return {
        state: {
          url: link.url,
          title: link.title,
          content: await readSaved(env, link.content_key, "Saved content is missing. Extract it again."),
        },
        questions: job.kind === "autotag"
          ? tagQuestions(config.tags!)
          : lensQuestions(config.lens!), // legacy "query" jobs lack config.lens and fail above
      };
    });
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
            job.id,
          ),
        );
      let jobResult: unknown = result;
      if (job.kind === "lens") {
        const lens = config.lens!;
        const answer = lensAnswer(lens, result.answers);
        jobResult = { ...result, answer };
        statements.push(
          env.DB.prepare(
            `INSERT OR REPLACE INTO lens_results(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id) SELECT ?,?,?,?,?,?,?,? WHERE ${jobRunning}`,
          ).bind(
            link.id,
            lens.id,
            JSON.stringify(answer),
            lens.version,
            link.content_version,
            result.model,
            now,
            job.batch_id,
            job.id,
          ),
        );
      }
      statements.push(
        // A cancelled job publishes nothing; its paid answer stays in jobs.jev_outcome and Usage.
        env.DB.prepare("UPDATE jobs SET result=? WHERE id=? AND status='running'").bind(
          JSON.stringify(jobResult),
          job.id,
        ),
      );
      await env.DB.batch(statements);
    });
  },
};
