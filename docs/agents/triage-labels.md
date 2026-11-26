# Triage labels

Map each canonical triage role to the same label name in Linear:

| Role | Linear label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an unattended agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill names a triage role, use its corresponding Linear label. These labels are independent of workflow statuses and of the type labels below.

## Type labels

Every open ticket in the Linklog project carries exactly one type label. They exist in team FAC; do not create others.

| Type label | Use it when | Examples |
| --- | --- | --- |
| `Feature` | The ticket adds a new capability for the user. | A Slack import, a consent prompt, a new Settings page. |
| `Bug` | Something behaves differently from what was expected or documented. | A sign-out that skips cleanup, data kept against an ADR. |
| `Improvement` | The ticket improves the state of the project or its environment, and is neither a feature nor a bug. | Debt, code quality, tests, tooling, CI, docs, process, stability, performance, review follow-ups, owner decisions and wayfinder grilling that shape launch work. |

Rules:

- One type per open ticket. Add it when the ticket is created or triaged, and keep any triage labels (`needs-triage`, `ready-for-agent`, and so on).
- If a ticket could be two types, pick by its main outcome. A bug fix that mostly cleans up a test is `Improvement`. A defect users can hit is `Bug`.
- A wayfinder ticket (grilling, research, prototype, map, task) takes the type of the work it leads to. If that is unclear, leave it without a type and say so in a comment.
- Done tickets do not need a type.
- Check before saying a project is tidy: list the open tickets and confirm none has zero or two type labels.
