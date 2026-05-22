#!/usr/bin/env bash
# Stop hook: keep the session polling while it is watching a PR for CI to
# finish, so a dropped `subscribe_pr_activity` webhook can't leave a
# "merge once CI is green" task hung forever (the webhook wake is flaky in
# the web sandbox). See CLAUDE.md "Merge-on-green".
#
# Inert by default: with no .pr-watch sentinel it exits 0 and the session
# stops normally. The sentinel is created ONLY when an agent is explicitly
# watching a PR, so ordinary sessions — including local interactive ones —
# are completely unaffected (one stat() per Stop).
#
# The sentinel lives at the repo ROOT (.pr-watch), NOT under .claude/: this
# harness gates writes/deletes under .claude/ behind a permission prompt,
# which would interrupt the otherwise hands-off loop. A root-level gitignored
# file is touched with plain bash and never prompts.
#
# When the sentinel exists, the hook sleeps ~one CI cycle then blocks the
# stop, feeding the agent back a get_check_runs re-check (a real turn, so
# it can call the GitHub MCP tools — the shell here has no token and the
# shared egress IP is rate-limited, so bash itself cannot read CI status).
# Bounded by DEADLINE: a stuck/queued PR can never loop forever, and a
# missing/garbled DEADLINE fails safe (clears the sentinel, allows stop).
set -uo pipefail

proj="${CLAUDE_PROJECT_DIR:-.}"
sentinel="$proj/.pr-watch"

# Not watching anything → let the session stop.
[ -f "$sentinel" ] || exit 0

# Parse via grep (never source — the file must not be executed).
pr=$(grep -oE '^PR=[0-9]+' "$sentinel" | head -1 | cut -d= -f2)
repo=$(grep -oE '^REPO=[^[:space:]]+' "$sentinel" | head -1 | cut -d= -f2)
deadline=$(grep -oE '^DEADLINE=[0-9]+' "$sentinel" | head -1 | cut -d= -f2)
now=$(date +%s)

# Fail safe: no usable deadline, or past it → stop polling.
if ! [ "${deadline:-0}" -gt "$now" ] 2>/dev/null; then
  rm -f "$sentinel"
  printf '{"decision":"block","reason":"PR watch on #%s ended (deadline reached or sentinel was malformed); .pr-watch has been cleared. Do one final get_check_runs via mcp__github__pull_request_read, report the outcome to the user, and do NOT recreate the sentinel."}\n' "${pr:-?}"
  exit 0
fi

# Poll every 20 s so completion is caught fast (CI here finishes in ~1 min).
# Kept well under the 60 s Stop-hook timeout.
sleep "${PR_WATCH_POLL_SECONDS:-20}"

printf '{"decision":"block","reason":"Still watching PR #%s (%s) for CI. Re-check now: mcp__github__pull_request_read method=get_check_runs. If every required check has conclusion success, merge via mcp__github__merge_pull_request then run exactly: rm -f .pr-watch . If any check failed, run rm -f .pr-watch then reproduce-and-fix per the CLAUDE.md autofix cap (or report if out of scope). If checks are still queued or in_progress, just end your turn and this hook will poll again."}\n' "${pr:-?}" "${repo:-}"
exit 0
