import { test, expect } from "bun:test";
import {
  MAX_JEV_TEXT_CHARS,
  capJevText,
  validateAnswers,
  type Question,
} from "../worker/ai/jev";

const MARKER = "\n\n[Content truncated for classification]";
const textLength = (state: { description?: string; content: string }) =>
  (state.description?.length ?? 0) + state.content.length;

test("capJevText returns a state within the cap as the same reference", () => {
  const short = { url: "https://example.com", description: "d", content: "hello" };
  expect(capJevText(short)).toBe(short);
  const exact = { content: "x".repeat(MAX_JEV_TEXT_CHARS) };
  expect(capJevText(exact)).toBe(exact);
});

test("capJevText leaves non-string content and non-objects alone", () => {
  const odd = { content: 42, description: "d".repeat(MAX_JEV_TEXT_CHARS * 2) };
  expect(capJevText(odd)).toBe(odd);
  expect(capJevText("text")).toBe("text");
  expect(capJevText(null)).toBeNull();
});

test("capJevText keeps description then the beginning of the body within the cap, marker included", () => {
  const state = {
    url: "https://example.com",
    title: "T",
    description: "DESCRIPTION",
    content: "HEAD " + "x".repeat(MAX_JEV_TEXT_CHARS * 3) + " TAIL",
  };
  const out = capJevText(state) as typeof state;
  expect(textLength(out)).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
  expect(out.description).toBe("DESCRIPTION");
  expect(out.content.startsWith("HEAD x")).toBe(true);
  expect(out.content.endsWith(MARKER)).toBe(true);
  expect(out.content).not.toContain("TAIL");
  expect(out.url).toBe(state.url);
  expect(Object.keys(out)).toEqual(["url", "title", "description", "content"]);
  expect(state.content.endsWith(" TAIL")).toBe(true);
});

test("capJevText trims a description longer than half the cap and still leaves room for the body", () => {
  const state = {
    description: "d".repeat(MAX_JEV_TEXT_CHARS),
    content: "HEAD " + "x".repeat(MAX_JEV_TEXT_CHARS),
  };
  const out = capJevText(state) as typeof state;
  expect(out.description.length).toBe(MAX_JEV_TEXT_CHARS / 2);
  expect(out.content.startsWith("HEAD x")).toBe(true);
  expect(out.content.endsWith(MARKER)).toBe(true);
  expect(textLength(out)).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
});

test("capJevText caps a body with no description", () => {
  const out = capJevText({ content: "x".repeat(MAX_JEV_TEXT_CHARS + 1) }) as { content: string };
  expect(out).not.toHaveProperty("description");
  expect(out.content.length).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
  expect(out.content.endsWith(MARKER)).toBe(true);
});

const scoreQuestion: Record<string, Question> = {
  quality: {
    type: "score",
    instructions: "Rate the writing quality.",
    criteria: ["poor", "ok", "great"],
  },
};

const FRONTMATTER = '---\ntitle: "Parrot - Wikipedia"\nmeta:\n  "og:title": "Parrot - Wikipedia"\n---\n\n';
const NAVIGATION =
  "[Jump to content](#bodyContent)\n\nMain menu\n\nmove to sidebar hide\n\nNavigation\n\n" +
  "- [Main page](https://en.wikipedia.org/wiki/Main_Page)\n- [Contents](https://en.wikipedia.org/wiki/Wikipedia:Contents)\n\n" +
  "Search\n\nAppearance\n\nToggle the table of contents\n\n";
const ARTICLE = "# Parrot\n\nThe parrot is a bird. " + "It lives in forests and eats seeds. ".repeat(900) + "TAIL";

test("capJevText drops leading site navigation before the article title when the text is over the cap", () => {
  const stored = FRONTMATTER + NAVIGATION + ARTICLE;
  const state = { description: "A bird.", content: stored };
  const out = capJevText(state) as typeof state;
  expect(out.content.startsWith("# Parrot\n\nThe parrot is a bird.")).toBe(true);
  expect(out.content).not.toContain("Jump to content");
  expect(out.content).not.toContain("og:title");
  expect(out.content.endsWith(MARKER)).toBe(true);
  expect(textLength(out)).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
  expect(state.content).toBe(stored);
});

test("capJevText sends a short page with navigation unchanged", () => {
  const short = { content: FRONTMATTER + NAVIGATION + "# Parrot\n\nA bird." };
  expect(capJevText(short)).toBe(short);
});

test("capJevText drops the navigation without a marker when the article then fits", () => {
  const lead = NAVIGATION + "- [Link](https://example.com)\n".repeat(200);
  const article = "# Parrot\n\n" + "A bird sentence. ".repeat(1200);
  expect(lead.length + article.length).toBeGreaterThan(MAX_JEV_TEXT_CHARS);
  expect(article.length).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
  const out = capJevText({ content: lead + article }) as { content: string };
  expect(out.content).toBe(article);
});

test("capJevText keeps a lead-in that has prose, and a lead-in that is too long", () => {
  const prose = "This introduction explains in some detail what the following document is about and why it matters. ";
  const withProse = { content: prose + "\n\n# Title\n\n" + "x".repeat(MAX_JEV_TEXT_CHARS) };
  expect((capJevText(withProse) as { content: string }).content.startsWith("This introduction")).toBe(true);
  const longLead = { content: "- [nav](https://example.com)\n".repeat(400) + "# Title\n\n" + "x".repeat(MAX_JEV_TEXT_CHARS) };
  expect((capJevText(longLead) as { content: string }).content.startsWith("- [nav]")).toBe(true);
});

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
