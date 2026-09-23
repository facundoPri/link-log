import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OCR_USAGE_COLUMNS } from "../worker/usage";

test("OCR usage separates image calls from browser calls and keeps unknown costs visible", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE usage_events(job_id TEXT, service TEXT, status TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, estimated_usd REAL)");
  const insert = db.query("INSERT INTO usage_events VALUES (?,?,?,?,?,?,?)");
  insert.run("a", "browser-content", "done", null, null, null, null);
  insert.run("a", "image-ocr", "done", "gemma", 1200, 200, 0.00018);
  insert.run("a", "image-ocr", "failed", "gemma", null, null, null);
  insert.run("b", "browser-content", "done", null, null, null, null);
  insert.run("b", "image-ocr", "started", "gemma", null, null, null);

  const rows = db.query(`SELECT job_id,${OCR_USAGE_COLUMNS} FROM usage_events WHERE status IN ('done','failed') GROUP BY job_id ORDER BY job_id`).all() as Record<string, number | string | null>[];
  expect(rows[0]).toMatchObject({ job_id: "a", ocr_images: 2, ocr_input_tokens: 1200, ocr_output_tokens: 200, ocr_model: "gemma", ocr_usd: 0.00018, ocr_unknown_cost_calls: 1 });
  expect(rows[1]).toMatchObject({ job_id: "b", ocr_images: 0, ocr_usd: null, ocr_unknown_cost_calls: 0 });
  db.close();
});
