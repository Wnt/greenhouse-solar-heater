# Quickstart: Add Home Screen Support

**Date**: 2026-03-22
**Feature**: 009-add-home-screen-support

## What This Feature Does

Makes the Greenhouse Monitor app installable to the home screen on Android (Chrome) and iOS (Safari). When installed, the app launches in standalone mode (no browser chrome) and shows a branded offline page when the server is unreachable.

## Files Changed

| File | Change |
|------|--------|
| `monitor/manifest.json` | Add `id`, maskable icon purpose |
| `monitor/index.html` | Add Apple meta tags (apple-mobile-web-app-capable, apple-touch-icon, status-bar-style) |
| `monitor/login.html` | Add manifest link, theme-color, Apple meta tags |
| `monitor/sw.js` | Add fetch handler with offline fallback |
| `monitor/offline.html` | **New** — branded offline fallback page |
| `monitor/server.js` | Whitelist PWA resources in auth gate |

## How to Verify

### Android (Chrome)
1. Open the monitor URL in Chrome on Android
2. Chrome should show an install prompt or "Add to Home Screen" in the menu
3. Install and verify: app icon on home screen, launches in standalone mode

### iOS (Safari)
1. Open the monitor URL in Safari on iPhone/iPad
2. Tap Share → "Add to Home Screen"
3. Verify: correct icon and name in dialog, launches in standalone mode

### Offline Fallback
1. Install the app to home screen
2. Disconnect from network
3. Open the app — should see branded offline page
4. Reconnect — page should auto-reload

### Lighthouse Check
1. Open Chrome DevTools → Lighthouse
2. Run "Progressive Web App" audit
3. "Installable" section should pass

## Prerequisites

No new dependencies. No new environment variables. No infrastructure changes.
