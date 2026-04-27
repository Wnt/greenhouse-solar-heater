#!/usr/bin/env bash
# Pre-push CI gate for Claude Code sessions.
#
# Wired in via .claude/settings.json as a PreToolUse hook on Bash, so it
# only fires inside Claude Code sessions (gated by CLAUDECODE=1, which
# the harness always sets) — humans pushing from a normal shell are
# unaffected. Mirrors the suite that .github/workflows/ci.yml runs on
# PR, so a green hook means a green CI.
#
# Why: CLAUDE.md's Pre-Push Checklist was clear, but on 2026-04-27
# the agent (Claude) misread `check:file-size --strict` output and
# dismissed a real hard-cap failure as pre-existing noise, producing
# red CI on PR #86. Match exit code, not output — this hook does that
# mechanically.

set -uo pipefail

# Read the tool-call payload (JSON via stdin per Claude Code's hook
# contract) and pull out the actual command string. If parsing fails,
# behave as no-match — better to let the call through than to block on
# our own bug.
payload=$(cat)
command=$(printf '%s' "$payload" | node -e '
let buf = "";
process.stdin.on("data", c => buf += c).on("end", () => {
  try { console.log(JSON.parse(buf).tool_input?.command || ""); }
  catch { /* unparseable -> empty string -> no-match */ }
});
' 2>/dev/null || printf '')

# Only gate `git push`. Any other Bash command (status, diff, fetch,
# build invocations, …) passes through with zero overhead.
case "$command" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$repo_root" ]; then
  exit 0
fi
cd "$repo_root"

# If deps aren't installed we can't run the gate. Skip rather than
# block — the dev is presumably mid-bootstrap and `npm ci` will bring
# the gate up.
if [ ! -d node_modules ]; then
  echo "⚠️  pre-push-gate: node_modules missing, skipping. Run 'npm ci' first." >&2
  exit 0
fi

echo "🛡️  Pre-push CI gate (mirrors .github/workflows/ci.yml)" >&2

logfile=$(mktemp)
trap 'rm -f "$logfile"' EXIT

run_step() {
  local label="$1"; shift
  local start=$(date +%s)
  if "$@" >"$logfile" 2>&1; then
    printf "  ✓ %-26s (%ds)\n" "$label" "$(( $(date +%s) - start ))" >&2
    return 0
  fi
  local elapsed=$(( $(date +%s) - start ))
  printf "  ✗ %-26s (%ds)\n" "$label" "$elapsed" >&2
  echo "" >&2
  echo "── failing output (last 40 lines of step) ──" >&2
  tail -40 "$logfile" >&2
  echo "" >&2
  echo "Push blocked. Rerun the failing step locally, fix it, then push again." >&2
  echo "Bypass for one-off pushes (docs-only, etc.): SKIP_PUSH_GATE=1 git push …" >&2
  exit 2  # PreToolUse exit 2 → deny tool call, stderr returned to Claude.
}

# Escape hatch for genuine "I know what I'm doing" cases. Off by default.
if [ "${SKIP_PUSH_GATE:-0}" = "1" ]; then
  echo "  ⚠ SKIP_PUSH_GATE=1 set, skipping gate" >&2
  exit 0
fi

run_step "lint"                npm run lint --silent
run_step "knip"                npm run knip --silent
run_step "file-size (strict)"  npm run check:file-size --silent -- --strict
run_step "assets (strict)"     npm run check:assets --silent -- --strict
run_step "unit tests"          npm run test:unit --silent

echo "✅ All gates green — proceeding with push." >&2
