import { expect, test } from "bun:test";
import { featureCost, featureUnits, formatBrowserTime, formatUsd, minutesUntil } from "../src/lib/usage-format";

test("units read in the unit a feature is billed in", () => {
  expect(featureUnits({ inputTokens: 1_200_000, outputTokens: 300, browserMs: 0 })).toBe("1.2M tokens");
  expect(featureUnits({ inputTokens: 0, outputTokens: 0, browserMs: 150_000 })).toBe("2.5 min");
  expect(featureUnits({ inputTokens: 900, outputTokens: 100, browserMs: 42_000 })).toBe("1K tokens · 42 s");
  expect(featureUnits({ inputTokens: 0, outputTokens: 0, browserMs: 0 })).toBe("");
  expect([formatBrowserTime(850), formatBrowserTime(4_500_000)]).toEqual(["850 ms", "1.3 h"]);
});

test("a small estimate keeps its digits; nothing billed reads as a dash", () => {
  expect([formatUsd(0.0009), formatUsd(0.042), formatUsd(12.5)]).toEqual(["$0.0009", "$0.042", "$12.50"]);
  expect(formatUsd(0.000045)).toBe("<$0.0001");
  expect(featureCost({ usd: 0.042 })).toBe("$0.042");
  expect(featureCost({ usd: 0 })).toBe("—");
});

test("the window reset reads in whole minutes, at least one", () => {
  const now = Date.parse("2026-11-01T10:00:00Z");
  expect(minutesUntil("2026-11-01T10:12:10Z", now)).toBe(13);
  expect(minutesUntil("2026-11-01T10:00:20Z", now)).toBe(1);
});
