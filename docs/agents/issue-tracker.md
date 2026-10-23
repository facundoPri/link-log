# Issue tracker: Linear

Issues and specs live in the existing [Linklog project](https://linear.app/facundopri/project/linklog-f69d633088ae), under team FacundoPri (`FAC`).

- Project UUID: `21c42bf8-b9ce-43f3-b692-9982c94d1abd`.
- Project identifier: `P-FAC-5`.
- Team UUID: `d28d4e5c-a277-4bfe-b11e-cd899a8095dc`.

## Operations

Use the connected Linear tools. If using Orca's CLI, first load the `orca-linear` skill and its version-matched guide.

- Fetch a ticket by its `FAC-<number>` identifier, UUID, or Linear URL; include comments when relevant.
- List issues scoped to the Linklog project. Project-search results alone do not establish whether it has tickets.
- When a skill says to publish an issue or spec, create an issue in this project and team. Check for an existing ticket first.
- Apply the label names in `docs/agents/triage-labels.md`. Read the existing labels before editing and preserve unrelated labels.
- Read available team statuses before changing workflow state. Triage labels and workflow statuses are separate fields.
- Represent parent/child work and blocking relationships with Linear's native issue relationships.
- After a write, read the ticket back and report its identifier and URL. Confirm completion from the successful read.

GitHub hosts code and pull requests. Link relevant PRs to their Linear tickets.

If Linear access is unavailable, report the blocker and retain a local draft. Publishing still means writing to Linear.
