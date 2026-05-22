#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Provisions the repo so the gate suite (lint, knip, unit, Playwright)
# runs without manual setup. Two things bite every fresh web session,
# both documented in CLAUDE.md "Test Setup Gotchas":
#   1. node_modules isn't present in the freshly-cloned container.
#   2. The sandbox pre-caches ONE Chromium revision under
#      $PLAYWRIGHT_BROWSERS_PATH, but the repo pins the latest
#      @playwright/test (which bundles a newer revision), so Playwright
#      can't find its browser. We install the matching version with
#      --no-save, leaving package.json/lock on the latest release.
#
# Synchronous (no {"async":true} on stdout) so deps are guaranteed ready
# before the agent runs anything. Remote-only, idempotent, and never
# hard-fails the session (warnings to stderr, always exit 0). All
# diagnostics go to stderr — SessionStart stdout is injected into the
# session context, so we keep stdout empty.
set -uo pipefail

# Local devs manage their own environment; only act in the web sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 1. Dependencies. A cached container keeps node_modules between sessions,
#    so this is a no-op after the first run.
if [ ! -d node_modules ]; then
  echo "session-start: installing npm dependencies (npm ci)…" >&2
  npm ci >&2 || { echo "session-start: npm ci failed — run it manually" >&2; exit 0; }
fi

# 2. Align Playwright with the sandbox's pre-cached Chromium revision.
cache_path="${PLAYWRIGHT_BROWSERS_PATH:-}"
if [ -n "$cache_path" ] && [ -d "$cache_path" ]; then
  cached=$(ls "$cache_path" 2>/dev/null | grep -E '^chromium-[0-9]+$' | sort -V | tail -1 | sed 's/chromium-//')
  installed=$(node -pe "const p=require('path').dirname(require.resolve('playwright-core/package.json')); JSON.parse(require('fs').readFileSync(p+'/browsers.json','utf8')).browsers.find(b=>b.name==='chromium').revision" 2>/dev/null || echo "")

  if [ -n "$cached" ] && [ -n "$installed" ] && [ "$cached" != "$installed" ]; then
    # chromium revision → highest @playwright/test version bundling it.
    # Mirror of chromium_to_pw_version() in pre-push-gate.sh — keep in sync.
    case "$cached" in
      1187) ver="1.55.0" ;;
      1194) ver="1.56.1" ;;
      1200) ver="1.57.0" ;;
      1208) ver="1.58.1" ;;
      1217) ver="1.59.1" ;;
      *) ver="" ;;
    esac
    # Probe fallback for revisions not in the table (~10 s).
    if [ -z "$ver" ]; then
      for v in 1.55.0 1.56.0 1.56.1 1.57.0 1.58.0 1.58.1 1.59.0 1.59.1 1.60.0 1.61.0; do
        npm pack --silent "playwright-core@$v" >/dev/null 2>&1 || continue
        rev=$(tar -xOf "playwright-core-$v.tgz" package/browsers.json 2>/dev/null \
          | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).browsers.find(x=>x.name==='chromium').revision" 2>/dev/null)
        rm -f "playwright-core-$v.tgz"
        [ "$rev" = "$cached" ] && { ver="$v"; break; }
      done
    fi
    if [ -n "$ver" ]; then
      echo "session-start: aligning Playwright to cached Chromium $cached (@playwright/test@$ver)…" >&2
      npm install --no-save "@playwright/test@$ver" "playwright@$ver" >&2 || \
        echo "session-start: playwright align failed (continuing)" >&2
    else
      echo "session-start: no @playwright/test match for Chromium $cached; see CLAUDE.md probe recipe" >&2
    fi
  fi
fi

exit 0
