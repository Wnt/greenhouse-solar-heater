# Research: JS Reload Prompt

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## R1: Version Detection Mechanism

**Decision**: Server-side content hash endpoint (`GET /version`)

**Rationale**: The server already serves all static files through `server.js`. Computing a hash of the JS module contents at startup (and recomputing on file change or using filesystem stat) is the simplest approach that requires no build step, no manifest generation, and no new dependencies. The client fetches this hash on page load, stores it, and polls periodically to compare.

**Alternatives considered**:
- **ETag-based detection** (HEAD requests on individual JS files): Would require multiple requests per check cycle and the server currently sends no ETag headers. Adding ETags would work but polling 7+ files is wasteful.
- **Service Worker with cache-first strategy**: The app has no service worker; adding one for just version checking introduces unnecessary complexity and caching side effects.
- **WebSocket push notification**: The app already has WebSocket for live data, but the version check is needed even in simulation mode when WS may not be connected. Polling is simpler and always works.
- **Build-time manifest with content hashes**: Would require a build step; the project currently has none and serves files directly. Overkill for this use case.

## R2: Hash Computation Strategy

**Decision**: Compute a combined hash from the modification times and sizes of all JS files in `playground/js/` at server startup, and recompute when the endpoint is hit (with short-lived caching to avoid excessive filesystem reads).

**Rationale**: Using `fs.statSync` on the known set of JS modules is fast (<1ms for 7 files) and requires no crypto dependency. A simple string concatenation of `mtime + size` for each file, then a lightweight hash (or even just the concatenated string), is sufficient for change detection. Node.js built-in `crypto.createHash` can produce a short SHA-256 hex digest.

**Alternatives considered**:
- **Full content hashing**: Reading and hashing all file contents on every request is more I/O intensive. Stat-based detection catches all deploys (which always update mtime) and is cheaper.
- **Package.json version field**: Only changes on manual version bumps — doesn't detect actual file changes from deployments.
- **Git commit hash**: Requires git to be available in the container and doesn't directly indicate which files changed. The Docker image may not include `.git`.

## R3: Polling Interval

**Decision**: 30-second polling interval, configurable via a constant in the module.

**Rationale**: 30 seconds balances responsiveness (spec requires notification within 60 seconds) with minimal server load. Each poll is a single lightweight HTTP request returning ~70 bytes. Even with multiple tabs open, the server impact is negligible.

## R4: Toast UI Pattern

**Decision**: Fixed-position toast banner at the bottom of the viewport, above the FAB, using Stitch design system colors and typography.

**Rationale**: The app already has a staleness banner pattern (`.staleness-banner` in CSS) and a FAB at bottom-right. A toast at the bottom-center, using the primary gold color (#e9c349) on a dark container (#574500), will feel native to the design system and signal "informational update" rather than "error." Editorial language in Newsreader serif font for the heading and Manrope for the body.

**Alternatives considered**:
- **Top banner**: Could obscure navigation or feel more intrusive.
- **Modal dialog**: Too disruptive for an optional action.
- **Browser notification**: Requires permission and feels disconnected from the app.

## R5: Editorial Language

**Decision**: Use warm, confident, slightly literary language. Example copy:

- Headline: "A new edition is available"
- Body: "We've made some improvements. Refresh to see the latest."
- Actions: "Refresh now" (primary) / "Later" (dismiss)

**Rationale**: The user explicitly requested editorial style. The Stitch design system uses Newsreader serif for headlines, which naturally conveys editorial gravitas. The language should feel like a tasteful magazine notification, not a system alert.
