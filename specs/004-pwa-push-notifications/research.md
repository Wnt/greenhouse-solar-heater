# Research: PWA Push Notifications for Valve Changes

**Date**: 2026-03-21
**Feature**: 004-pwa-push-notifications

## R-001: Web Push Library for Node.js

**Decision**: Use `web-push` npm package (v3.6.7)

**Rationale**: The de facto standard library for Web Push in Node.js. Works with CommonJS `require()` (matches existing `poc/server.js` pattern). Handles VAPID authentication, payload encryption (RFC 8291), and push service communication. Supports Node.js >= 16 (project uses Node 20 LTS).

**Alternatives considered**:
- Manual Web Push implementation — rejected; complex crypto (ECDH + AES-GCM + HKDF) with no benefit over a battle-tested library
- Firebase Cloud Messaging (FCM) — rejected; proprietary, adds unnecessary dependency on Google services for a self-hosted system

## R-002: VAPID Key Management

**Decision**: Generate VAPID keys on first server startup if none exist in S3, then persist to S3 using the existing `s3-storage.js` adapter pattern.

**Rationale**: VAPID keys must remain stable across restarts — changing them invalidates all existing push subscriptions. Storing in S3 (alongside WebAuthn credentials) follows the existing persistence pattern. A separate S3 key (`push-config.json`) avoids coupling with the credentials store.

**Alternatives considered**:
- Environment variables for VAPID keys — rejected; adds deployment friction, keys are auto-generated not user-chosen
- Generate new keys per deployment — rejected; would invalidate all subscriptions on each deploy

## R-003: Server-Side Valve Polling

**Decision**: Add a polling loop in `server.js` that calls the Shelly controller's `Script.Eval` RPC (same mechanism as the browser client) at the same 10-second interval. Compare valve state against previous poll to detect changes.

**Rationale**: The server already proxies Shelly RPC calls. Reusing the same HTTP GET approach (`http.get` to the Shelly device) keeps the implementation consistent. The server needs its own polling loop because push notifications must be sent even when no browser is open.

**Alternatives considered**:
- Shelly webhooks/event notifications — investigated but Shelly scripting has limited outbound HTTP capabilities and the 5 HTTP call limit makes reliable event delivery fragile
- WebSocket from Shelly — Shelly devices don't support outbound WebSocket connections from scripts

## R-004: Push Subscription Storage

**Decision**: Store push subscriptions as a JSON array in S3 under key `push-subscriptions.json`. Each entry is the browser's `PushSubscription` object (`endpoint`, `keys.p256dh`, `keys.auth`).

**Rationale**: Simple, matches the existing `credentials.json` pattern. The number of subscriptions is tiny (single user, handful of devices) — no need for a database. The `endpoint` URL uniquely identifies each subscription.

**Alternatives considered**:
- Store in the same file as WebAuthn credentials — rejected; different data lifecycle, avoids coupling
- SQLite or other embedded DB — rejected; overkill for <10 entries, adds dependency

## R-005: Service Worker Scope

**Decision**: Register the service worker at `/sw.js` (root of the PoC) with default scope `/`. The service worker handles `push` and `notificationclick` events only — no `fetch` interception or offline caching.

**Rationale**: Push notifications require a service worker registered at or above the page scope. Root scope is simplest. No offline caching is needed (FR-013 and assumptions) — the app requires live connectivity to Shelly devices anyway.

**Alternatives considered**:
- Scope to a sub-path — rejected; unnecessary complexity, no other service workers in the project
- Add offline caching — explicitly out of scope per spec assumptions

## R-006: PWA Manifest Requirements

**Decision**: Create `poc/manifest.json` with `"display": "standalone"`, app name "Greenhouse Monitor", theme colors matching existing PoC CSS, and generated PNG icons (192x192, 512x512).

**Rationale**: Minimum viable manifest for PWA installability requires: `name`, `short_name`, `start_url`, `display`, `icons` (192px + 512px), and `theme_color`. Icons can be simple SVG-to-PNG conversions or programmatically generated.

**Alternatives considered**:
- Skip icons — rejected; browsers won't show install prompt without appropriately sized icons
- Use maskable icons — nice-to-have but not required for basic installability

## R-007: Stale Subscription Cleanup

**Decision**: When `web-push.sendNotification()` returns HTTP 404 or 410, immediately remove that subscription from the stored array and persist the updated list to S3.

**Rationale**: These status codes indicate the subscription is permanently invalid (expired or user unsubscribed from the push service). Keeping them wastes API calls and can trigger rate limiting. Cleanup happens naturally during notification delivery — no separate job needed.

**Alternatives considered**:
- Periodic subscription validation job — rejected; unnecessary complexity for a handful of subscriptions
- Keep stale entries with a "failed" flag — rejected; no retry value for 404/410 errors

## R-008: Controller IP Configuration

**Decision**: Use environment variable `CONTROLLER_IP` to configure the Shelly controller IP for server-side polling. Falls back to no polling if not set (local-only mode doesn't need push notifications).

**Rationale**: The browser currently takes the controller IP as user input. The server needs a configured IP for background polling. Environment variables match the existing config pattern (`VPN_CHECK_HOST`, `AUTH_ENABLED`, etc.).

**Alternatives considered**:
- Read from `scripts/devices.conf` — rejected; that file is for deployment scripts, not the PoC server
- KVS or config endpoint — rejected; over-engineering for a single value
