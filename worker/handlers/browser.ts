import { lensAnswer, lensQuestions } from "../ai/jev";
import { evaluateWithJev, readSaved } from "./jev-step";
import type { Answer } from "../../src/types";
import type { BrowserJobHandler } from "./index";

type CaptureMeta = {
  source: "dom" | "metadata";
  capturedAt: string;
  completeness: "complete" | "partial";
  reasons: string[];
  facts: { key: string; label: string; value: string }[];
  description: string;
  siteName: string;
};

/** Evaluates an ephemeral browser capture. Never reads or writes `links`. */
export const browserEvaluationHandler: BrowserJobHandler = {
  pool: () => "jev",
  async run({ env, step, job, target, config }) {
    const lens = config.lens;
    if (!lens) throw new Error("The evaluation has no lens definition.");
    const result = await evaluateWithJev(env, step, { ...job, link_id: null }, async () => {
      const content = await readSaved(env, target.capture_key, "The page snapshot is no longer available. Evaluate the tab again.");
      const meta = JSON.parse(target.capture_meta) as CaptureMeta;
      return {
        state: {
          url: target.url,
          title: target.title,
          description: meta.description || undefined,
          site: meta.siteName || undefined,
          // Provenance travels with the evidence so partial captures are not read as complete.
          source:
            meta.source === "metadata"
              ? "Only the tab title and URL"
              : "Text read from the page as loaded in the user's browser",
          completeness: meta.completeness,
          limitations: meta.reasons.length ? meta.reasons : undefined,
          facts: meta.facts.length
            ? Object.fromEntries(meta.facts.map((f) => [f.label, f.value]))
            : undefined,
          content,
        },
        questions: lensQuestions(lens),
      };
    });
    await step.do("save-evaluation", async () => {
      let answer: Answer = lensAnswer(lens, result.answers);
      // Autogroup options are opaque Jev keys; hand back the page's destination keys.
      if (answer.type === "choice" && config.destinations) {
        const map = config.destinations;
        answer = {
          ...answer,
          choice: map[answer.choice] ?? answer.choice,
          probabilities: Object.fromEntries(
            Object.entries(answer.probabilities).map(([k, v]) => [map[k] ?? k, v]),
          ),
        };
      }
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE browser_targets SET answer=?,model=?,evaluated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='running')",
        ).bind(JSON.stringify(answer), result.model, now, target.id, job.id),
        env.DB.prepare("UPDATE jobs SET result=? WHERE id=? AND status='running'").bind(
          JSON.stringify({ answer, model: result.model }),
          job.id,
        ),
      ]);
    });
    // The snapshot is temporary: drop it as soon as the evaluation no longer needs it.
    await step.do("drop-snapshot", async () => {
      if (target.capture_key) await env.CONTENT.delete(target.capture_key);
      await env.DB.prepare("UPDATE browser_targets SET capture_key=NULL WHERE id=?")
        .bind(target.id)
        .run();
    });
  },
};
