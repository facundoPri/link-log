import { expect, test } from "bun:test";
import { TestD1 } from "./support/d1";

test("language provenance migration fixes existing transcripts without touching missing content or genuine errors", async () => {
  const db = await TestD1.migrated("0015");
  db.sqlite.exec("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Test','test@example.test',1,'t','t')");
  const warning = "Original audio language could not be verified; English was used.";
  for (const [id, selectedLanguage, issues, state] of [
    ["complete", "en", [warning], "partial"],
    ["missing", null, ["No transcript available"], "partial"],
    ["error", "en", [warning, "Content was truncated"], "partial"],
    ["queued", "en", [warning], "queued"],
  ] as const) {
    db.sqlite.query("INSERT INTO links(user_id,id,original_url,url,domain,title,created_at,content_key,content_source,content_state,content_error,content_details) VALUES('owner',?,?,?,'youtube.com','Video','t','existing.md','youtube',?,?,?)")
      .run(id, `https://example.com/${id}`, `https://example.com/${id}`, state, issues[0]!, JSON.stringify({ type: "youtube-video", completeness: "unverified", issues, transcript: { reason: "english-original-unknown", selectedLanguage } }));
  }
  await db.migrate("0016", "0015");
  const row = (id: string) => db.sqlite.query("SELECT content_state,content_error,content_key,content_details FROM links WHERE id=?").get(id) as any;
  expect(row("complete")).toMatchObject({ content_state: "ready", content_error: null, content_key: "existing.md" });
  expect(JSON.parse(row("complete").content_details)).toMatchObject({ completeness: "verified", issues: [], transcript: { reason: "english-original-unknown", selectedLanguage: "en" } });
  expect(row("missing")).toMatchObject({ content_state: "partial", content_error: "No transcript available" });
  expect(row("error")).toMatchObject({ content_state: "partial", content_error: "Content was truncated" });
  expect(row("queued").content_state).toBe("queued");
  expect(db.sqlite.query("SELECT count(*) n FROM jobs").get()).toEqual({ n: 0 });
});
