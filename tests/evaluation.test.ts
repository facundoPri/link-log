import { describe, test, expect } from "bun:test";
import {
  tagQuestions,
  lensQuestions,
  lensAnswer,
  validateAnswers,
} from "../worker/ai/jev";
import { pastedUrls } from "../src/url";
import type { Lens, Tag } from "../src/types";

const lens = (partial: Partial<Lens>): Lens => ({
  id: "l1",
  name: "Test",
  type: "noul",
  scope: "library",
  question: "Is this relevant?",
  options: [],
  levels: [],
  criteria: { yes: "", no: "" },
  threshold: 0.8,
  version: 1,
  created_at: "2024-01-01",
  ...partial,
});
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
    expect((qs.ai!.criteria as Record<string, string>).true).toBe(
      tags[0]!.description,
    );
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
    const q = lensQuestions(
      lens({
        type: "choice",
        question: "Topic?",
        options: [
          { key: "a", label: "AI", description: "" },
          { key: "b", label: "Cloud", description: "" },
          { key: "other", label: "Other", description: "" },
        ],
      }),
    );
    expect(
      validateAnswers(
        {
          lens: {
            type: "choice",
            choice: "a",
            confidence: 0.7,
            probabilities: { a: 0.8, b: 0.1, other: 0.1 },
          },
        },
        q,
      ).lens?.type,
    ).toBe("choice");
    expect(() =>
      validateAnswers(
        {
          lens: {
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
  test("multi lens asks one noul per option and composes a multi answer", () => {
    const multi = lens({
      type: "multi",
      question: "Which topics does this cover?",
      options: [
        { key: "ai", label: "AI", description: "Machine learning content" },
        { key: "dev", label: "Developer tools", description: "" },
      ],
    });
    const qs = lensQuestions(multi);
    expect(Object.keys(qs).sort()).toEqual(["opt_ai", "opt_dev"]);
    expect(qs.opt_ai!.type).toBe("noul");
    expect(qs.opt_ai!.instructions).toContain('"AI"');
    expect(
      (qs.opt_ai!.criteria as Record<string, string>).true,
    ).toBe('"AI" applies: Machine learning content');
    expect(
      (qs.opt_dev!.criteria as Record<string, string>).true,
    ).toBe('"Developer tools" applies to this document.');
    const answers = validateAnswers(
      {
        opt_ai: { type: "noul", noul: 0.9 },
        opt_dev: { type: "noul", noul: 0.2 },
      },
      qs,
    );
    expect(lensAnswer(multi, answers)).toEqual({
      type: "multi",
      probabilities: { ai: 0.9, dev: 0.2 },
    });
    const noul = lens({ type: "noul" });
    expect(
      lensAnswer(noul, { lens: { type: "noul", noul: 0.7 } }),
    ).toEqual({ type: "noul", noul: 0.7 });
    expect(() => lensAnswer(multi, { opt_ai: { type: "noul", noul: 0.9 } })).toThrow();
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
