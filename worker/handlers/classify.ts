import { judge, tagQuestions, lensQuestions, lensAnswer } from "../ai/jev";
import { evaluationStatements } from "../ai/persist";
import type { JobHandler } from "./index";

export const classifyHandler: JobHandler = {
  pool: () => "jev",
  async run({ env, step, job, link, config }) {
    const result = await step.do(
      "evaluate-jev",
      { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
      async () => {
        await env.DB.prepare(
          "UPDATE jobs SET step='Evaluating with Jev' WHERE id=?",
        )
          .bind(job.id)
          .run();
        const object = await env.CONTENT.get(link.content_key!);
        if (!object)
          throw new Error("Saved content is missing. Extract it again.");
        if (job.kind !== "autotag" && !config.lens)
          throw new Error("This job predates lenses; it can't be run.");
        return judge(
          env,
          {
            url: link.url,
            title: link.title,
            content: await object.text(),
          },
          job.kind === "autotag"
            ? tagQuestions(config.tags!)
            : lensQuestions(config.lens!), // legacy "query" jobs lack config.lens and fail here
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
      let jobResult: unknown = result;
      if (job.kind === "lens") {
        const lens = config.lens!;
        const answer = lensAnswer(lens, result.answers);
        jobResult = { ...result, answer };
        statements.push(
          env.DB.prepare(
            "INSERT OR REPLACE INTO lens_results(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id) VALUES(?,?,?,?,?,?,?,?)",
          ).bind(
            link.id,
            lens.id,
            JSON.stringify(answer),
            lens.version,
            link.content_version,
            result.model,
            now,
            job.batch_id,
          ),
        );
      }
      statements.push(
        env.DB.prepare("UPDATE jobs SET result=? WHERE id=?").bind(
          JSON.stringify(jobResult),
          job.id,
        ),
      );
      await env.DB.batch(statements);
    });
  },
};
