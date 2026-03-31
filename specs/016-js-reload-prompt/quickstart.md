# Quickstart: JS Reload Prompt

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## What This Feature Does

Detects when the app's JavaScript has been updated on the server and shows a tasteful prompt inviting the user to refresh. The prompt uses editorial-style language consistent with the Stitch design system.

## How It Works

1. **Server**: A new `GET /version` endpoint returns the `GIT_COMMIT` environment variable (baked into the Docker image at build time via `github.sha`). The hash changes on each deployment.

2. **Client**: A new `playground/js/version-check.js` module fetches the hash on page load (baseline) and polls every 30 seconds. When the hash changes, it shows a toast banner.

3. **Toast**: A fixed-position banner at the bottom of the screen with editorial copy ("A new edition is available"), a "Refresh now" button and a "Later" dismiss link. Styled with Stitch gold/dark palette.

## Files Changed

| File | Change |
|------|--------|
| `server/server.js` | Add `GET /version` endpoint |
| `playground/js/version-check.js` | New module: polling, comparison, toast DOM |
| `playground/index.html` | Import `version-check.js` |
| `playground/css/style.css` | Toast banner styles |
| `tests/version-check.test.js` | Unit tests for hash computation |
| `tests/e2e/version-check.spec.js` | E2e test for prompt behavior |

## How to Test

### Unit tests
```bash
npm run test:unit
```

### E2e tests
```bash
npm run test:e2e
```

### Manual verification
1. Start the server with a commit hash: `GIT_COMMIT=abc123 node server/server.js`
2. Open the app in a browser
3. Stop the server, restart with a different hash: `GIT_COMMIT=def456 node server/server.js`
4. Wait up to 30 seconds — the toast should appear
5. Click "Refresh now" — page reloads with updated code
6. Alternatively, click "Later" — toast disappears, reappears after next poll cycle

Note: In local dev without `GIT_COMMIT` set, the hash defaults to `"unknown"` and the toast never triggers (by design).
