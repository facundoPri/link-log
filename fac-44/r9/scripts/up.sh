#!/bin/sh
# Usage: up.sh <ui port> <api port> <label>. Starts a fresh instance in the verifier's own worktree after
# confirming HEAD is 25003d1, then runs doctor. Prints the run dir on the last line.
set -e
WT=/Users/facundopri/Documents/ChatGPT/link-log/.claude/worktrees/agent-a55cbee428ba69c54
EV=/private/tmp/claude-501/-Users-facundopri-orca-workspaces-link-log-fac-44-url-upload/5ffefc72-7986-4e11-830b-b12621ae2bc3/scratchpad/evidence/final-r9
cd "$WT"
HEAD=$(git rev-parse HEAD)
echo "$(date -u +%FT%TZ) $3 HEAD $HEAD" >> "$EV/heads.txt"
[ "$HEAD" = 25003d1bf4591fac1fddd8da7e830f26589b4ed4 ] || { echo "WRONG HEAD $HEAD"; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "DIRTY WORKTREE"; git status --porcelain; exit 2; }
bun .agents/skills/verify-linklog/scripts/verify.ts up --fast-retries --var BROWSER_CONCURRENCY=1 --ui-port "$1" --api-port "$2" > "$EV/up-$3.txt" 2>&1
cat "$EV/up-$3.txt"
RUN=$(sed -n 's/^run: //p' "$EV/up-$3.txt")
bun .agents/skills/verify-linklog/scripts/verify.ts doctor --run "$RUN" > "$EV/doctor-$3.txt" 2>&1
cat "$EV/doctor-$3.txt"
echo "$RUN"
