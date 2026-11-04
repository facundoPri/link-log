import { describe, expect, test } from "bun:test";
import { batchProgressNote } from "../src/bulkActions";
import { rowJobLabel } from "../src/failures";
import type { Batch, Job } from "../src/types";

const job = (status: Job["status"], step: string, kind = "lens") => ({ status, step, kind }) as unknown as Job;

describe("link row label", () => {
  test("a queued, waiting or running job reads In progress… whatever its stored step", () => {
    for (const j of [
      job("queued", "En cola"),
      job("waiting", "Waiting for Jev slot"),
      job("running", "Waiting for Jev slot"),
      job("running", "Waiting for Browser slot", "extract"),
      job("running", "Applying lens"),
      job("running", "Fetching preview", "preview"),
      job("running", "Tagging", "autotag"),
    ])
      expect(rowJobLabel(j)).toBe("In progress…");
  });

  test("a settled job or no job shows no label", () => {
    expect(rowJobLabel(job("done", "Applying lens"))).toBeNull();
    expect(rowJobLabel(job("failed", "Applying lens"))).toBeNull();
    expect(rowJobLabel(undefined)).toBeNull();
  });
});

describe("batch toast", () => {
  const batch = (over: Partial<Batch>) => ({ total: 10, done: 0, failed: 0, cancelled: 0, active: 10, ...over }) as Batch;

  test("counts every settled job against the total", () => {
    expect(batchProgressNote(batch({}))).toBe("0 of 10");
    expect(batchProgressNote(batch({ done: 3, failed: 1, cancelled: 1, active: 5 }))).toBe("5 of 10");
  });
});
