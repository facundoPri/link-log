// Prints the SQL Better Auth needs for the Worker's exact options, using the documented
// getMigrations API against an empty in-memory SQLite. Review the output before committing a
// migration; never run auth migrations per request or from a public route.
//   bun scripts/auth/print-schema.ts > /tmp/auth.sql
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../../worker/auth";

const config = {
  appEnv: "test" as const,
  baseURL: "http://localhost:3000",
  secret: "schema-generation-only-secret-0000000000",
  emailFrom: "Linklog <no-reply@linklog.localhost>",
  emailDailyLimit: 1,
};
const { compileMigrations } = await getMigrations(
  authOptions(config, new Database(":memory:"), { send() {} }, () => {}),
);
console.log(await compileMigrations());
