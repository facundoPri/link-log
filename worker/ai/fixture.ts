import { stableHash } from "@linklog/browser-protocol";
import type { Question } from "../../src/types";

/**
 * Deterministic stand-in for Jev used only by automated tests (JEV_PROVIDER="fixture"
 * plus ALLOW_FIXTURE_JEV="1"). Markers in the content steer the answer:
 * jev:yes · jev:no · jev:unsure · jev:choice=<label> · jev:score=<n> · jev:fail · jev:slow=<ms>.
 * Without markers the answer is derived from a stable hash of the content.
 */
export async function fixtureJev(input: {
  state: unknown;
  questions: Record<string, Question>;
}): Promise<Record<string, unknown>> {
  const content = JSON.stringify(input.state);
  const slow = content.match(/jev:slow=(\d{1,5})/);
  if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
  if (content.includes("jev:fail")) throw new Error("Fixture provider failure.");
  const seed = (salt: string) => parseInt(stableHash(content + salt).slice(0, 6), 16) / 0xffffff;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(input.questions)) {
    if (q.type === "noul") {
      const noul = content.includes("jev:yes")
        ? 0.95
        : content.includes("jev:no")
          ? 0.05
          : content.includes("jev:unsure")
            ? 0.6
            : Math.round(seed(q.instructions) * 100) / 100;
      answers[id] = { type: "noul", noul };
    } else if (q.type === "choice") {
      const criteria = q.criteria as Record<string, string>;
      const keys = Object.keys(criteria);
      const wanted = content.match(/jev:(?:choice|group)=([^"\\\n]{1,60}?)(?:\\n|"|\s|$)/)?.[1]?.toLowerCase();
      const choice =
        (wanted && keys.find((k) => k === wanted || criteria[k]!.toLowerCase().startsWith(wanted))) ||
        keys[Math.floor(seed(q.instructions) * keys.length)]!;
      const rest = (1 - 0.9) / Math.max(keys.length - 1, 1);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? (keys.length > 1 ? 0.9 : 1) : rest]));
      answers[id] = { type: "choice", choice, confidence: probabilities[choice], probabilities };
    } else {
      const levels = (q.criteria as string[]).length;
      const marked = content.match(/jev:score=(\d+)/);
      const score = marked ? Math.min(Number(marked[1]), levels - 1) : Math.floor(seed(q.instructions) * levels);
      const probabilities = Object.fromEntries(
        Array.from({ length: levels }, (_, i) => [String(i), i === score ? 1 : 0]),
      );
      answers[id] = { type: "score", score, confidence: 1, probabilities, legend: {} };
    }
  }
  return {
    answers,
    model: "fixture/jev",
    usage: { input_tokens: Math.ceil(content.length / 4), output_tokens: 8 * Object.keys(input.questions).length },
  };
}
