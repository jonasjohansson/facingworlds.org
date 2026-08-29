#!/usr/bin/env bash
# Progress bar for a running Claude Code workflow.
# Usage: scripts/wf-progress.sh <runId> [totalAgents]
#   e.g. scripts/wf-progress.sh wf_407581e4-f4d 9
# Finds the newest workflow journal if no runId is given.
set -euo pipefail

BASE="$HOME/.claude/projects/-Users-jonas-GitHub-org-jonasjohansson-facingworlds-org"
RUN="${1:-}"
TOTAL="${2:-0}"

if [ -n "$RUN" ]; then
  J=$(find "$BASE" -type d -name "*${RUN#wf_}*" -path "*/workflows/*" 2>/dev/null | head -1)/journal.jsonl
else
  J=$(find "$BASE" -name journal.jsonl -path "*/workflows/*" 2>/dev/null \
      -exec stat -f '%m %N' {} + | sort -rn | head -1 | cut -d' ' -f2-)
fi

[ -f "$J" ] || { echo "no workflow journal found"; exit 1; }

N=$(grep -c '"type":"result"' "$J" || true)
[ "$TOTAL" -gt 0 ] || TOTAL=$((N > 0 ? N : 1))

W=30
FILLED=$(( N * W / TOTAL )); [ "$FILLED" -gt "$W" ] && FILLED=$W
printf '  ['
printf '%0.s#' $(seq 1 "$FILLED") 2>/dev/null || true
printf '%0.s.' $(seq 1 $((W - FILLED))) 2>/dev/null || true
printf ']  %d/%d agents\n' "$N" "$TOTAL"
