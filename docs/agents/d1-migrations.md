# D1 migrations

How a migration in `migrations/` reaches production, and what to check before writing one.

## Deploy order

`.github/workflows/deploy-production.yml` records a D1 Time Travel bookmark, applies the migrations, then deploys the Worker. Two consequences:

- The previous Worker serves requests on the new schema until `wrangler deploy` finishes, and for good if the deploy step fails. Old code must keep working on the new schema: a new column it never writes stays NULL, a changed foreign key acts on its deletes.
- The first way back is `wrangler d1 time-travel restore` to that bookmark, which the step logs. It also drops every write made after it.

## Changing a table

SQLite can't alter a foreign key or a CHECK in place, so the table is rebuilt (see 0010, 0013, 0029):

1. Create `<table>_next` with the new shape, copy the rows, and rebuild every child table against `<table>_next` the same way. Dropping a parent runs an implicit DELETE, so its children's ON DELETE actions would fire.
2. Drop the old tables children-first, then rename each `_next` table. Renames rewrite references.
3. Recreate the indexes and triggers of every rebuilt table.

When ON DELETE changes, so does what outlives a parent. For CASCADE to SET NULL, list every count, aggregate, retry and view that reads the child rows, and check what each does with a row whose parent is gone. If user data stays after a delete, say so in the ADR or ask the owner.

## Rollback scripts

A script in `scripts/migrations/rollback/NNNN_*.down.sql` restores the schema of the migration before it. Write it from that schema (`await TestD1.migrated("<previous number>")`, then read `sqlite_master`), not by editing the up file. `tests/rollback-schema.test.ts` diffs every script's result against that schema. A documented leftover goes in its `KEPT` list.

## Tests

`TestD1` in `tests/support/d1.ts` applies the migrations and runs every script, its `sqlite.exec` included, one statement at a time, so a failing statement fails where D1 would.
