import { describe, test, expect } from "bun:test";
import {
  tagQuestions,
  queryQuestions,
  validateAnswers,
} from "../worker/ai/jev";
import { pastedUrls } from "../src/url";
import type { Tag } from "../src/types";
const tags: Tag[] = [
  {
    id: "ai",
    name: "AI",
    description: "Inteligencia artificial aplicada",
    threshold: 0.8,
    version: 1,
  },
  {
    id: "iot",
    name: "IoT",
    description: "Dispositivos conectados",
    threshold: 0.65,
    version: 1,
  },
];
describe("typed classification", () => {
  test("independent labels preserve both rejected and accepted probabilities", () => {
    const qs = tagQuestions(tags);
    expect(Object.values(qs).map((q) => q.type)).toEqual(["noul", "noul"]);
    expect(qs.ai?.criteria.true).toBe(tags[0]!.description);
    const answers = validateAnswers(
      { ai: { type: "noul", noul: 0.94 }, iot: { type: "noul", noul: 0.45 } },
      qs,
    );
    expect(Object.keys(answers)).toHaveLength(2);
    expect(answers.iot).toEqual({ type: "noul", noul: 0.45 });
  });
  test("rejects partial or invalid evaluation before replacing assignments", () => {
    const q = tagQuestions(tags);
    for (const raw of [
      { ai: { type: "noul", noul: 1 } },
      { ai: { type: "noul", noul: 1.1 }, iot: { type: "noul", noul: 0.4 } },
      {
        ai: { type: "choice", choice: "yes" },
        iot: { type: "noul", noul: 0.4 },
      },
    ])
      expect(() => validateAnswers(raw, q)).toThrow();
  });
  test("Choice validates the complete competing distribution", () => {
    const q = queryQuestions({
      type: "choice",
      question: "Topic?",
      options: { a: "AI", b: "Cloud", other: "Other" },
      threshold: 0.8,
    });
    expect(
      validateAnswers(
        {
          query: {
            type: "choice",
            choice: "a",
            confidence: 0.7,
            probabilities: { a: 0.8, b: 0.1, other: 0.1 },
          },
        },
        q,
      ).query?.type,
    ).toBe("choice");
    expect(() =>
      validateAnswers(
        {
          query: {
            type: "choice",
            choice: "a",
            confidence: 0.7,
            probabilities: { a: 0.8 },
          },
        },
        q,
      ),
    ).toThrow();
  });
  test("multiple pasted URLs deduplicate normalized trackers and reject prose", () => {
    expect(
      pastedUrls(
        "https://example.com?utm_source=x\nhttps://example.com\nhttps://youtube.com/watch?v=abcdef12345",
      ),
    ).toHaveLength(2);
    expect(pastedUrls("read this https://example.com")).toEqual([]);
  });
});
