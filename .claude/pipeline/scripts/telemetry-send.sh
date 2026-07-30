#!/bin/sh
# telemetry-send.sh — fire-and-forget anonymous usage ping (SCHEMA.md §Telemetry).
#
#   telemetry-send.sh <phase> <feature_id> <seconds> [results]
#     phase    brainstorm|spec|build|smoke|review|fix|ship — the feature funnel, and only it.
#              Setup/maintenance commands never ping (SCHEMA.md §Telemetry).
#     feature  the feature id — NEVER sent raw; SHA-256-hashed to 12 hex chars
#     seconds  batch wall-clock
#     results  optional compact summary, e.g. "ok,ok" or "REVISE:3"
#
# GDPR posture (documented in SCHEMA.md §Telemetry):
#   - STRICTLY opt-in: exits silently unless ~/.claude/cohorte.config.yaml has
#     telemetry.enabled: true AND a non-empty endpoint AND an install_id
#     (all three written only by the explicit consent flow).
#   - Data minimization: no repo names, no paths, no code, no IP handling client-side.
#   - Never blocks or fails the pipeline: 2s timeout, all errors swallowed, exit 0 always.
set -u

cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte.config.yaml"
[ -f "$cfg" ] || exit 0

# read keys scoped to the `telemetry:` block only
tval() {
  awk -v key="$1" '
    /^telemetry:/       { in_t=1; next }
    /^[a-zA-Z]/         { in_t=0 }
    in_t && $1 == key":" {
      v=$2; gsub(/^"|"$|#.*/,"",v); gsub(/"/,"",v); print v; exit
    }' "$cfg"
}

[ "$(tval enabled)" = "true" ] || exit 0
endpoint="$(tval endpoint)";   [ -n "$endpoint" ]   || exit 0
install_id="$(tval install_id)"; [ -n "$install_id" ] || exit 0

phase="${1:-}"; feature="${2:-}"; seconds="${3:-0}"; results="${4:-}"
[ -n "$phase" ] || exit 0

# Allowlist the phase here — the collector accepts any string, so a typo in a command
# file would silently pollute the dataset with a phantom phase nobody notices.
case "$phase" in
  brainstorm|spec|build|smoke|review|fix|ship) ;;
  *) exit 0 ;;
esac

if command -v shasum >/dev/null 2>&1; then
  fhash=$(printf '%s' "$feature" | shasum -a 256 | cut -c1-12)
else
  fhash=$(printf '%s' "$feature" | sha256sum | cut -c1-12)
fi
ver=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pipeline/VERSION" 2>/dev/null | head -1)
os=$(uname -s 2>/dev/null || echo unknown)
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

payload=$(printf '{"v":1,"install_id":"%s","ts":"%s","core_version":"%s","os":"%s","event":"phase","phase":"%s","feature_hash":"%s","seconds":%s,"results":"%s"}' \
  "$install_id" "$ts" "$ver" "$os" "$phase" "$fhash" "${seconds:-0}" "$results")

curl -s -m 2 -X POST -H 'content-type: application/json' \
  -d "$payload" "$endpoint" >/dev/null 2>&1 || true
exit 0
