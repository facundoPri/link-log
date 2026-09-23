import { test, expect } from "bun:test";
import {
  MAX_STATE_CHARS,
  truncateState,
  validateAnswers,
  type Question,
} from "../worker/ai/jev";

test("truncateState caps string content and marks the cut", () => {
  const state = {
    url: "https://example.com",
    content: "x".repeat(MAX_STATE_CHARS + 50),
  };
  const out = truncateState(state) as typeof state;
  expect(out.content.length).toBe(
    MAX_STATE_CHARS + "\n\n[Content truncated for classification]".length,
  );
  expect(out.content.endsWith("[Content truncated for classification]")).toBe(
    true,
  );
  expect(out.url).toBe("https://example.com");
});

test("truncateState leaves short content, non-string content and primitives alone", () => {
  const short = { content: "hello" };
  expect(truncateState(short)).toBe(short);
  expect(truncateState({ content: 42 })).toEqual({ content: 42 });
  expect(truncateState("text")).toBe("text");
});

const scoreQuestion: Record<string, Question> = {
  quality: {
    type: "score",
    instructions: "Rate the writing quality.",
    criteria: ["poor", "ok", "great"],
  },
};

test("validateAnswers accepts a well-formed score answer", () => {
  const answers = validateAnswers(
    {
      quality: {
        type: "score",
        score: 1.4,
        confidence: 0.8,
        probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
        legend: { "0": "poor", "1": "ok", "2": "great" },
      },
    },
    scoreQuestion,
  );
  expect(answers.quality!.type).toBe("score");
});

test("validateAnswers rejects an out-of-range or unnormalized score answer", () => {
  const base = {
    type: "score" as const,
    confidence: 0.8,
    probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
    legend: { "0": "poor", "1": "ok", "2": "great" },
  };
  expect(() =>
    validateAnswers({ quality: { ...base, score: 3.2 } }, scoreQuestion),
  ).toThrow("Invalid score distribution.");
  expect(() =>
    validateAnswers(
      {
        quality: {
          ...base,
          score: 1,
          probabilities: { "0": 0.5, "1": 0.6, "2": 0.3 },
        },
      },
      scoreQuestion,
    ),
  ).toThrow("Invalid score distribution.");
  expect(() =>
    validateAnswers(
      {
        quality: { ...base, score: 1, probabilities: { "0": 1 } },
      },
      scoreQuestion,
    ),
  ).toThrow("Invalid score distribution.");
});
