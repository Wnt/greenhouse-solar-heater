# Research: Add Home Screen Support

**Date**: 2026-03-22
**Feature**: 009-add-home-screen-support

## R1: Current PWA State Assessment

**Decision**: Extend the existing PWA scaffolding rather than rebuilding it.

**Rationale**: The app already has the core pieces — manifest.json (with name, display: standalone, icons), sw.js (push notifications), and service worker registration in index.html. The gaps are specific and well-defined:

1. **Missing Apple meta tags** — index.html and login.html lack `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, and `apple-touch-icon` link.
2. **No fetch handler in SW** — sw.js only handles push events, no fetch interception, no offline fallback.
3. **No offline fallback page** — when offline, users see browser error.
4. **Login page has no PWA metadata** — no manifest link, no theme-color meta tag.
5. **Auth gate blocks PWA resources** — `manifest.json`, `sw.js`, and icon paths are not whitelisted, so unauthenticated users in cloud mode can't access them (breaks installability).

**Alternatives considered**: Building a separate PWA wrapper — rejected as unnecessary complexity; extending the existing setup is straightforward.

## R2: Android PWA Installability Requirements

**Decision**: Add a fetch handler to the service worker and ensure manifest completeness.

**Rationale**: Chrome's PWA installability criteria (as of 2025+) require:
- Valid web app manifest with `name` or `short_name`, `start_url`, `display` (standalone/fullscreen/minimal-ui), at least one 192px and one 512px icon — **already satisfied**.
- A registered service worker with a `fetch` event handler — **missing**. The SW must intercept fetch events, even if it just falls through to network. For good UX, serve an offline fallback on navigation failures.
- HTTPS — **satisfied** (Caddy provides TLS in production).
- `maskable` icon purpose — recommended for adaptive icons on Android. Can add to manifest by declaring an existing icon as maskable (if the icon has sufficient safe zone padding) or creating a separate maskable variant.

**Alternatives considered**: Using `beforeinstallprompt` event to show custom install UI — rejected as out of scope; the browser's native install prompt is sufficient.

## R3: iOS Home Screen Support

**Decision**: Add Apple-specific meta tags to both index.html and login.html.

**Rationale**: Safari on iOS does not fully support the Web App Manifest for home screen behavior. It requires:
- `<meta name="apple-mobile-web-app-capable" content="yes">` — enables standalone mode.
- `<meta name="apple-mobile-web-app-status-bar-style" content="default">` — controls status bar appearance. `default` gives a white status bar; `black-translucent` makes it transparent over the page content.
- `<link rel="apple-touch-icon" href="/icons/icon-192.png">` — specifies the home screen icon. iOS prefers 180x180 but will downscale 192x192. A dedicated 180x180 icon is optional.

Apple splash screen images (`apple-touch-startup-image`) are not required and would need many size variants for different devices — deferred.

**Alternatives considered**: Creating dedicated 180x180 Apple icon — deferred; 192px downscales cleanly.

## R4: Offline Fallback Strategy

**Decision**: Network-first strategy with offline fallback for navigation requests only.

**Rationale**: The app is fundamentally online (reads live sensor data). Full offline caching would add complexity with no real benefit. The strategy:
1. On SW install, pre-cache a single `offline.html` page and the app icon.
2. On fetch events for navigation requests (HTML pages), try the network first. If the network fails, serve the cached `offline.html`.
3. For non-navigation requests (CSS, JS, API calls, images), pass through to network without interception — these are either served by the server or fail gracefully in the existing UI.
4. The offline page includes auto-retry logic (periodically checks connectivity, reloads when back online).

This approach keeps the service worker simple and avoids cache invalidation complexity.

**Alternatives considered**:
- Cache-first for static assets — rejected; adds cache versioning complexity and the app is small enough that re-fetching is fine.
- Stale-while-revalidate — rejected; overkill for this use case.

## R5: Auth Gate Whitelist for PWA Resources

**Decision**: Add `manifest.json`, `sw.js`, icon paths, and `offline.html` to the auth whitelist.

**Rationale**: For PWA installability, the browser needs to access `manifest.json`, `sw.js`, and icons without authentication. These resources contain no sensitive data. The auth whitelist in `server.js` (line 274) already exempts login assets; the same pattern applies to PWA resources.

Resources to whitelist:
- `/manifest.json`
- `/sw.js`
- `/offline.html`
- `/icons/icon-192.png`
- `/icons/icon-512.png`

**Alternatives considered**: Serving PWA resources from a separate unauthenticated path — rejected; unnecessary complexity.

## R6: Maskable Icon

**Decision**: Declare the existing 512px icon with `"purpose": "any maskable"` in the manifest, after verifying it has adequate safe zone padding.

**Rationale**: Android adaptive icons crop to various shapes (circle, squircle, etc.). A maskable icon needs content within the inner 80% "safe zone." If the existing icon already has adequate padding, it can be declared as both `any` and `maskable`. If it doesn't, a separate maskable variant with added padding should be created.

If the icon is too tight for maskable use, the simpler approach is to add a second manifest entry pointing to the same file with `"purpose": "maskable"` and accept slight cropping, or create a simple padded version.

**Alternatives considered**: Creating a dedicated maskable icon — may be needed if existing icon lacks safe zone; can be assessed during implementation.
