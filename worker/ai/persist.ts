import type { Link, Tag } from "../../src/types";
import { tagQuestions, validateAnswers, type Answer } from "./jev";
import { jobRunning } from "../attention";
/**
 * Validate the complete response before building a transaction that replaces the last evaluation.
 * Every statement applies only while `jobId` is still running: a cancelled job never replaces what a
 * later job (or the user) wrote.
 */
export function evaluationStatements(
  db: D1Database,
  link: Pick<Link, "id" | "content_version">,
  tags: Tag[],
  answers: Record<string, Answer>,
  model: string,
  batchId: string,
  now: string,
  jobId: string,
) {
  validateAnswers(answers, tagQuestions(tags));
  const statements = [
    db.prepare(`DELETE FROM link_tags WHERE link_id=? AND ${jobRunning}`).bind(link.id, jobId),
    db.prepare(`DELETE FROM tag_evaluations WHERE link_id=? AND ${jobRunning}`).bind(link.id, jobId),
  ];
  for (const tag of tags) {
    const answer = answers[tag.id]!;
    if (answer.type !== "noul") throw new Error("Invalid answer.");
    statements.push(
      db
        .prepare(
          `INSERT INTO tag_evaluations(link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id) SELECT ?,id,?,?,?,?,?,?,?,? FROM tags WHERE id=? AND ${jobRunning}`,
        )
        .bind(
          link.id,
          answer.noul,
          tag.threshold,
          tag.version,
          tag.description,
          link.content_version,
          model,
          now,
          batchId,
          tag.id,
          jobId,
        ),
    );
    if (answer.noul >= tag.threshold)
      statements.push(
        db
          .prepare(
            `INSERT INTO link_tags(link_id,tag_id,origin) SELECT ?,id,'auto' FROM tags WHERE id=? AND ${jobRunning}`,
          )
          .bind(link.id, tag.id, jobId),
      );
  }
  return statements;
}
