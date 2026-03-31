# Research: JS Reload Prompt

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## R1: Version Detection Mechanism

**Decision**: Server-side `GET /version` endpoint returning the `GIT_COMMIT` environment variable.

**Rationale**: The Dockerfile already accepts a `GIT_COMMIT` build arg (line 30-31) and the CD pipeline sets it to `github.sha` at build time. Returning this value from a simple endpoint requires zero filesystem access, no crypto, and no caching — just `process.env.GIT_COMMIT`. The client fetches this hash on page load, stores it, and polls periodically to compare.

**Alternatives considered**:
- **File-stat hashing** (SHA-256 of mtime+size for playground JS files): Initially implemented, but more complex (filesystem scanning, crypto, TTL caching) for no additional benefit. Replaced with GIT_COMMIT approach.
- **ETag-based detection** (HEAD requests on individual JS files): Would require multiple requests per check cycle. Wasteful.
- **Service Worker with cache-first strategy**: The app has no service worker; adding one introduces unnecessary complexity.
- **WebSocket push notification**: Version check is needed even in simulation mode when WS may not be connected. Polling is simpler.
- **Build-time manifest with content hashes**: Would require a build step; the project has none. Overkill.

## R2: Hash Source

**Decision**: Use `process.env.GIT_COMMIT` directly — no computation needed.

**Rationale**: The Docker image already has the git commit SHA baked in as an environment variable via `ARG GIT_COMMIT=unknown` / `ENV GIT_COMMIT=$GIT_COMMIT` in the Dockerfile, and the CD pipeline passes `GIT_COMMIT=${{ github.sha }}` at build time. This is the simplest possible approach: a single env var read, deterministic, and tied directly to what was deployed. Defaults to `"unknown"` in local development, which means the version check never triggers false positives locally.

**Alternatives considered**:
- **File-stat SHA-256 hash**: Initially implemented. More complex (filesystem scanning, crypto, TTL caching) with no benefit over the already-available env var.
- **Package.json version field**: Only changes on manual bumps — doesn't detect deployments.
- **Runtime `git rev-parse HEAD`**: Requires `.git` directory in the container, which is not present.

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
