#!/usr/bin/env bash
# Pre-push CI gate for Claude Code sessions.
#
# Wired in via .claude/settings.json as a PreToolUse hook on Bash, so it
# only fires inside Claude Code sessions (the harness sets CLAUDECODE=1
# and loads the project settings.json) — humans pushing from a normal
# shell are unaffected. Mirrors the suite that .github/workflows/ci.yml
# runs on PR, so a green hook means a green CI.
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

# Escape hatch for genuine "I know what I'm doing" cases (docs-only
# pushes, emergency rollbacks). Off by default.
if [ "${SKIP_PUSH_GATE:-0}" = "1" ]; then
  echo "⚠️  SKIP_PUSH_GATE=1 set — skipping pre-push gate" >&2
  exit 0
fi

echo "🛡️  Pre-push CI gate (mirrors .github/workflows/ci.yml)" >&2

logfile=$(mktemp)
unit_log=$(mktemp)
pw_log=$(mktemp)
trap 'rm -f "$logfile" "$unit_log" "$pw_log"' EXIT

# ── Helper: print Playwright cache-mismatch hint (Claude Cloud only) ──
# Only relevant when the sandbox pre-caches Chromium under
# PLAYWRIGHT_BROWSERS_PATH and the installed @playwright/test version
# bundles a different revision. Defined up here because Bash doesn't
# hoist function definitions — call sites later in the script need
# the definition to already be in scope.
# Pre-mapped chromium-revision → @playwright/test version, "highest
# version that bundles that revision". Probed via `npm pack` on
# 2026-04-27 across @playwright/test 1.55.0–1.59.1; extend as new
# releases ship. The map serves the common case (Claude Cloud
# currently ships chromium-1194 only) instantly, while the probe loop
# below remains as a future-proof fallback for unknown revisions.
chromium_to_pw_version() {
  case "$1" in
    1187) echo "1.55.0" ;;
    1194) echo "1.56.1" ;;
    1200) echo "1.57.0" ;;
    1208) echo "1.58.1" ;;
    1217) echo "1.59.1" ;;
    *) echo "" ;;
  esac
}

print_playwright_cache_hint() {
  local cache_path="${PLAYWRIGHT_BROWSERS_PATH:-}"
  if [ -z "$cache_path" ] || [ ! -d "$cache_path" ]; then
    return
  fi
  local cached_chromium installed_pw
  cached_chromium=$(ls "$cache_path" 2>/dev/null | grep -E '^chromium-[0-9]+$' | sort -V | tail -1 | sed 's/chromium-//')
  installed_pw=$(node -pe "require('@playwright/test/package.json').version" 2>/dev/null || echo "?")
  if [ -z "$cached_chromium" ]; then
    return
  fi

  cat >&2 <<HINT
── Claude Code cloud sandbox: Playwright cache mismatch ──
PLAYWRIGHT_BROWSERS_PATH = $cache_path
  cached Chromium revision : $cached_chromium
  installed @playwright/test: $installed_pw

The sandbox ships Chromium $cached_chromium pre-cached. The installed
@playwright/test bundles a different revision, so runtime launches
fail with "Executable doesn't exist at …chromium-<rev>…".

Fix without modifying package.json (the repo must stay on the latest
production-ready release):
HINT

  local mapped_version
  mapped_version=$(chromium_to_pw_version "$cached_chromium")

  if [ -n "$mapped_version" ]; then
    cat >&2 <<HINT

  # Run this exact command — chromium-$cached_chromium ships in @playwright/test@$mapped_version.
  npm install --no-save @playwright/test@$mapped_version playwright@$mapped_version
  npm test  # or rerun the gate / 'git push'
  # No revert needed — --no-save leaves package.json + lock untouched
  # and node_modules is gitignored.

HINT
  else
    cat >&2 <<HINT

  Cached revision $cached_chromium isn't in the script's pre-mapped
  table (.claude/hooks/pre-push-gate.sh chromium_to_pw_version).
  Probe to find the matching @playwright/test version (~10 s):

  for v in 1.55.0 1.56.0 1.56.1 1.57.0 1.58.0 1.58.1 1.59.0 1.59.1 1.60.0 1.61.0; do
    npm pack --silent "playwright-core@\$v" >/dev/null 2>&1 || continue
    rev=\$(tar -xOf "playwright-core-\$v.tgz" package/browsers.json \\
      | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).browsers.find(x=>x.name==='chromium').revision" 2>/dev/null)
    rm -f "playwright-core-\$v.tgz"
    [ "\$rev" = "$cached_chromium" ] && echo "match: @playwright/test@\$v"
  done

  Then: npm install --no-save @playwright/test@<matched> playwright@<matched>

  Add the new mapping to chromium_to_pw_version() in this hook so
  the next session gets the instant path.

HINT
  fi

  echo "See CLAUDE.md \"Test Setup Gotchas\" for the full background." >&2
}

# ── Static checks (sequential, ~5 s total) ────────────────────────────
run_step() {
  local label="$1"; shift
  local start=$(date +%s)
  if "$@" >"$logfile" 2>&1; then
    printf "  ✓ %-30s (%ds)\n" "$label" "$(( $(date +%s) - start ))" >&2
    return 0
  fi
  local elapsed=$(( $(date +%s) - start ))
  printf "  ✗ %-30s (%ds)\n" "$label" "$elapsed" >&2
  echo "" >&2
  echo "── failing output (last 40 lines) ──" >&2
  tail -40 "$logfile" >&2
  echo "" >&2
  echo "Push blocked. Rerun the failing step locally, fix it, then push again." >&2
  echo "Bypass for one-off pushes (docs-only, etc.): SKIP_PUSH_GATE=1 git push …" >&2
  exit 2  # PreToolUse exit 2 → deny tool call, stderr returned to Claude.
}

run_step "lint"                 npm run lint --silent
run_step "knip"                 npm run knip --silent
run_step "file-size (strict)"   npm run check:file-size --silent -- --strict
run_step "assets (strict)"      npm run check:assets --silent -- --strict

# ── Unit tests, then Playwright (sequential, ~65 s total) ─────────────
# CI runs these in parallel, but on the Claude Cloud sandbox the
# extra CPU contention from a parallel unit run produces sporadic
# Playwright flakes in view-navigation tests. Sequential adds ~5 s to
# wall clock and eliminates the flakiness.

unit_start=$(date +%s)
if npm run test:unit --silent >"$unit_log" 2>&1; then
  printf "  ✓ %-30s (%ds)\n" "unit tests" "$(( $(date +%s) - unit_start ))" >&2
else
  printf "  ✗ %-30s (%ds)\n" "unit tests" "$(( $(date +%s) - unit_start ))" >&2
  echo "" >&2
  echo "── unit failing output (last 40 lines) ──" >&2
  tail -40 "$unit_log" >&2
  echo "" >&2
  echo "Push blocked. Fix the failing step(s) and try again." >&2
  echo "Bypass for genuine emergencies: SKIP_PUSH_GATE=1 git push …" >&2
  exit 2
fi

pw_start=$(date +%s)
if npx playwright test --reporter=line >"$pw_log" 2>&1; then
  printf "  ✓ %-30s (%ds)\n" "Playwright (frontend + e2e)" "$(( $(date +%s) - pw_start ))" >&2
  echo "✅ All gates green — proceeding with push." >&2
  exit 0
fi

printf "  ✗ %-30s (%ds)\n" "Playwright (frontend + e2e)" "$(( $(date +%s) - pw_start ))" >&2
echo "" >&2
echo "── Playwright failing output (last 60 lines) ──" >&2
tail -60 "$pw_log" >&2
echo "" >&2

# Playwright's "browser binary missing" error in the Claude Code cloud
# sandbox: PLAYWRIGHT_BROWSERS_PATH points at a pre-cached Chromium
# whose revision must match the @playwright/test version installed.
# The repo tracks the latest production version, so when a sandbox
# caches an older revision the runtime can't find its browser.
if grep -qE "Executable doesn't exist|browserType\.launch.*Failed|chromium-[0-9]+ is not (found|installed)|browser binary not found" "$pw_log"; then
  print_playwright_cache_hint
fi

echo "" >&2
echo "Push blocked. Fix the failing step(s) and try again." >&2
echo "Bypass for genuine emergencies: SKIP_PUSH_GATE=1 git push …" >&2
exit 2
