#!/usr/bin/env bash
# Arm/disarm the PR-watch sentinel WITHOUT a Bash permission prompt.
# Allowlisted in .claude/settings.json as Bash(.claude/hooks/pr-watch.sh:*),
# so the whole merge-on-green loop runs hands-off (the MCP merge doesn't
# prompt either). The script only ever writes or deletes the fixed sentinel
# path — never anything else — which is why it is safe to allowlist.
# See CLAUDE.md "Merge-on-green" and .claude/hooks/pr-watch-stop.sh.
set -uo pipefail

proj="${CLAUDE_PROJECT_DIR:-.}"
sentinel="$proj/.claude/.pr-watch"

case "${1:-}" in
  arm)
    pr="${2:-}"
    mins="${3:-20}"
    case "$pr" in ''|*[!0-9]*) echo "usage: pr-watch.sh arm <PR-number> [minutes]" >&2; exit 1 ;; esac
    case "$mins" in ''|*[!0-9]*) mins=20 ;; esac
    printf 'PR=%s\nREPO=Wnt/greenhouse-solar-heater\nDEADLINE=%s\n' \
      "$pr" "$(( $(date +%s) + mins * 60 ))" > "$sentinel"
    echo "pr-watch armed: PR #$pr for ${mins} min"
    ;;
  disarm)
    rm -f "$sentinel"
    echo "pr-watch disarmed"
    ;;
  *)
    echo "usage: pr-watch.sh {arm <PR-number> [minutes] | disarm}" >&2
    exit 1
    ;;
esac
