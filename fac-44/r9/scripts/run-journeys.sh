#!/bin/sh
# Usage: run-journeys.sh <run dir> <label> <journey file>...  Doctor, then each journey; logs to journeys-<label>.out.txt.
WT=/Users/facundopri/Documents/ChatGPT/link-log/.claude/worktrees/agent-a55cbee428ba69c54
EV=/private/tmp/claude-501/-Users-facundopri-orca-workspaces-link-log-fac-44-url-upload/5ffefc72-7986-4e11-830b-b12621ae2bc3/scratchpad/evidence/final-r9
cd "$WT"
V="bun .agents/skills/verify-linklog/scripts/verify.ts"
RUN=$1; LABEL=$2; shift 2
OUT="$EV/journeys-$LABEL.out.txt"
{ echo "=== HEAD $(git rev-parse HEAD)"; echo "=== doctor $RUN"; $V doctor --run "$RUN"; } >> "$OUT" 2>&1
for j in "$@"; do
  echo "=== run $j on $RUN" >> "$OUT"
  $V run "$j" --run "$RUN" >> "$OUT" 2>&1
  echo "=== exit $? $j" >> "$OUT"
done
