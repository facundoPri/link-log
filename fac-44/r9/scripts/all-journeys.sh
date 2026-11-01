#!/bin/sh
# Runs every UI journey for r9 across instances i2-i6 in parallel; i3, i4, i5, i6 each hold one journey.
WT=/Users/facundopri/Documents/ChatGPT/link-log/.claude/worktrees/agent-a55cbee428ba69c54
J=$WT/.agents/skills/verify-linklog/journeys
EV=/private/tmp/claude-501/-Users-facundopri-orca-workspaces-link-log-fac-44-url-upload/5ffefc72-7986-4e11-830b-b12621ae2bc3/scratchpad/evidence/final-r9
R=$WT/.cache/verify-linklog
"$EV/run-journeys.sh" "$R/20261101-051542-3630" i3 "$J/api-submit-activity.ts" &
"$EV/run-journeys.sh" "$R/20261101-051548-3640" i4 "$J/api-submit-text.ts" &
"$EV/run-journeys.sh" "$R/20261101-051553-3650" i5 "$EV/journeys/r9-a-shared-budget.ts" &
"$EV/run-journeys.sh" "$R/20261101-051559-3660" i6 "$EV/journeys/r9-b-lockout.ts" &
"$EV/run-journeys.sh" "$R/20261101-051537-3620" i2 "$J/api-keys-settings.ts" "$J/api-keys-revoked-section.ts" "$J/usage-settings.ts" "$J/api-curl-example.ts" "$EV/journeys/r9-c-rename-usage.ts" "$J/api-keys-gate-fixes.ts" &
wait
grep -h "=== exit" "$EV"/journeys-i*.out.txt
