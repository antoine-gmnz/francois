#!/bin/sh
#
# preflight.sh — deterministic phase gate for /review and /smoke.
#
# Runs the profile's mechanical checks (typecheck, lint, tests — whatever the caller
# passes) BEFORE any agent is spawned. A red gate means the caller aborts and relays
# the raw failure — dispatching reviewers onto code that doesn't even compile burns
# their whole run on noise a compiler already printed for free.
#
#   preflight.sh <report-file> "<cmd>" ["<cmd>"...]
#
# - Each command runs through `sh -c`, all output appended to <report-file> — the bulk
#   never enters the calling agent's context.
# - First failure: prints the last 40 lines of the report raw to stderr and exits 1.
#   The caller must stop there — no agents.
# - All green: writes `<project>/.claude/preflight.ok` ("<epoch> <HEAD sha>") — the
#   stamp `hooks/gate.py` checks (gate-config.json `preflight` block) before letting
#   review/smoke agents dispatch.

set -u

report="${1:?usage: preflight.sh <report-file> \"<cmd>\" [\"<cmd>\"...]}"
shift
[ "$#" -gt 0 ] || { echo "preflight: no commands given" >&2; exit 2; }

mkdir -p "$(dirname "$report")" 2>/dev/null || true
: > "$report"

n=0
for cmd in "$@"; do
  [ -n "$cmd" ] || continue
  n=$((n + 1))
  printf '\n$ %s\n' "$cmd" >> "$report"
  if ! sh -c "$cmd" >> "$report" 2>&1; then
    echo "PREFLIGHT FAIL — $cmd" >&2
    echo "--- last 40 lines of $report ---" >&2
    tail -40 "$report" >&2
    exit 1
  fi
done

# Stamp for the gate.py phase gate: epoch + HEAD sha of the checkout we verified.
proj="${CLAUDE_PROJECT_DIR:-.}"
sha=$(git rev-parse HEAD 2>/dev/null || echo none)
mkdir -p "$proj/.claude" 2>/dev/null || true
printf '%s %s\n' "$(date +%s)" "$sha" > "$proj/.claude/preflight.ok" 2>/dev/null || true

echo "PREFLIGHT PASS ($n checks green) — full log: $report"
