# Quickstart: Remove Monitor App, Promote Playground

**Feature**: 013-remove-monitor-app
**Date**: 2026-03-26

## Prerequisites

- Node.js 20 LTS
- Playwright (with Chromium) for e2e tests
- Docker (for build verification)

## Development Setup

```bash
# Install dependencies
npm install

# Run unit tests (fast feedback)
npm run test:unit

# Run e2e tests (requires Chromium)
npm run test:e2e

# Run all tests
npm test
```

## Key Implementation Order

1. **Move server files**: `monitor/server.js` → `server/server.js`, `monitor/lib/` → `server/lib/`
2. **Delete monitor files**: all monitor UI, auth, push, PoC Shelly, vendored libs
3. **Simplify server.js**: remove auth, push routes; serve playground at `/`
4. **Update playground**: add hash-based deep linking, device config descriptions
5. **Update deploy**: Dockerfile, deploy.sh paths, shelly script copy
6. **Update tests**: delete monitor tests, fix import paths, add deep linking e2e test
7. **Update CLAUDE.md**: remove monitor documentation

## Verification Checklist

```bash
# 1. No monitor files remain
ls monitor/  # should fail: directory doesn't exist

# 2. Server starts and serves playground at root
node server/server.js &
curl http://localhost:3000/  # should return playground HTML
curl http://localhost:3000/js/ui.js  # should return playground JS

# 3. Tests pass
npm test

# 4. Docker builds
docker build -f deploy/docker/Dockerfile -t test-build .

# 5. Deep linking works (manual browser test)
# Open http://localhost:3000/#schematic → Schematic view should load
# Click Controls → URL should change to #controls
# Press browser Back → should return to #schematic
```

## File Change Summary

| Action | Count | Description |
|--------|-------|-------------|
| Delete | ~25 | Monitor UI, auth, push, PoC Shelly, vendored libs, tests |
| Move | ~12 | server.js + lib/ from monitor/ to server/ |
| Modify | ~15 | server.js, playground/index.html, Dockerfile, deploy.sh, tests, CLAUDE.md |
| Add | 1 | Deep linking e2e test |
