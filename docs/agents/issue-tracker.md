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

## Authorized issue lifecycle

The owner authorized these status updates on 2026-10-30. Execute them without
asking again when the corresponding work event occurs. This authorization covers
ticket status and evidence updates; merging a PR or deploying still follows the
authorization for that action.

| Work event                                                                                                  | Linear status                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Begin substantive work on the ticket, including scoped research or a prototype                              | `In Progress`                       |
| Deliver the ticket's result for review, with verification evidence and a non-draft PR when code is involved | `In Review`                         |
| All code required by the ticket is merged into `main`                                                       | `Done`                              |
| The owner accepts a research or decision ticket's deliverable                                               | `Done`, without requiring a code PR |

Reading a board or proposing possible work does not start every ticket mentioned.
Keep draft or incomplete work `In Progress`. A ready PR moves to `In Review`
even when the owner is the only reviewer. When requested changes require more
implementation, move it back to `In Progress`; restore `In Review` after verification.

At each transition:

1. Fetch the issue and available team statuses. Confirm its project and actual scope.
2. Compare the current state with the work event. If it already matches, leave it.
   Preserve an owner's explicit state choice; begin new work on a follow-up issue
   instead of reopening a completed decision or research ticket automatically.
3. Write the matching status through the connected Linear tools. Keep assignee,
   priority, labels, and unrelated fields unchanged.
4. Attach useful evidence once: worktree or branch when starting, PR and check
   results at review, merge URL and commit at completion. Add a new comment only
   when it supplies new information.
5. Read the issue back and confirm the persisted status. If a write times out,
   read before retrying. Report an unconfirmed or failed update rather than
   claiming the board was synchronized.

For an audit, reconcile stale ticket states with the observed GitHub state using
this same authorization. A related PR that covers only part of a ticket does not
complete the ticket. With several required PRs, wait for all of them to merge.
If deployment or external publication is part of the ticket's acceptance criteria,
keep that outcome visible and leave the ticket open until it is verified.

## PR linking contract

Read `.agents/skills/pr/SKILL.md` when writing a PR body. For work attached to
a Linear issue:

- Include the real issue ID in the branch name or PR title, such as
  `FAC-123: Describe the resulting behavior`.
- In the PR **description**, add `Closes FAC-123` for each issue the PR fully
  completes. Write one closing statement per issue, not an ID range.
- Use `Part of FAC-123` for partial work or `Relates to FAC-123` for context-only
  references. Do not put a closing statement on an umbrella ticket that has
  acceptance criteria outside the PR's scope.
- PR comments alone do not establish the magic-word link. Verify the issue's
  linked PR attachment after saving the description.
- After opening or marking a PR ready, move the issue to `In Review` and verify
  the read-back. After observing a merge, verify `Done`; repair a missing native
  transition through Linear instead of waiting for the user to notice it.

Work without an existing issue does not need a made-up ID. Check the project for
an existing ticket before creating one under the task's authorized scope.

## Native GitHub automation

Prefer Linear's existing GitHub integration to an additional Actions workflow.
GitHub must allow the integration to access `facundoPri/link-log`. The team-level
mapping belongs to **FAC**, which also contains issues from other projects.

In Linear's **Team settings → Workflows & automations → Pull request and commit
automations**, use this mapping when those controls are available:

- Draft PR: `In Progress`.
- Open non-draft PR, review requested, or ready for merge: `In Review`.
- PR or commit merge: `Done`. For work that must land in `main`, reserve the
  closing reference for that final PR; intermediate work uses `Part of`.

The agent still sets `In Progress` when work starts before a PR exists. Native
automation depends on PR links, and non-closing links do not apply the merge
transition. With multiple linked PRs, Linear waits for the last required PR.
Read back the issue rather than treating a setting or link as proof of delivery.

See [Linear's GitHub workflow documentation](https://linear.app/docs/github#workflow-automation).
If a control is absent or access is unavailable, retain these agent-managed
transitions and report exactly which native settings remain unverified. Do not
add a token, webhook, paid upgrade, or duplicate issue sync as an implicit fallback.

On 2026-10-30, the FAC mapping above was saved and verified after reloading
[the team workflow settings](https://linear.app/facundopri/settings/teams/FAC/workflow).
It is a team default, with no branch overrides; adding a branch rule requires
an admin. The personal options to start an issue when copying its branch name
or opening it in a coding tool were already enabled and were preserved.
