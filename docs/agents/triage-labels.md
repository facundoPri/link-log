# Triage labels

Map each canonical triage role to the same label name in Linear:

| Role | Linear label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an unattended agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill names a triage role, use its corresponding Linear label. These labels are independent of workflow statuses and issue-type labels such as Bug or Feature.
