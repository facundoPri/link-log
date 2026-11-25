// FAC-265: Cancel on a browser run's toast cancels every batch of the run, including one whose request was still in
// flight when the user clicked: it joins the run after the cancel and is cancelled on arrival.
import { expect, test } from "bun:test";
import { createRun } from "../src/sessionRuns";

test("Cancel cancels the run's batches, and a batch added afterwards on arrival", () => {
  const cancelledBatches: string[][] = [];
  const { run, session } = createRun({ cancelBatches: (ids) => cancelledBatches.push(ids), changed: () => {} });
  session.add("b1");
  expect(session.cancelled).toBe(false);
  run.cancel();
  expect(session.cancelled).toBe(true);
  expect(cancelledBatches).toEqual([["b1"]]);
  session.add("b2");
  expect(cancelledBatches).toEqual([["b1"], ["b2"]]);
  expect(run.batchIds).toEqual(["b1", "b2"]);
});

test("a batch added to a run nobody cancelled is not cancelled", () => {
  const cancelledBatches: string[][] = [];
  const { session } = createRun({ cancelBatches: (ids) => cancelledBatches.push(ids), changed: () => {} });
  session.add("b1");
  session.add("b2");
  expect(cancelledBatches).toEqual([]);
});
