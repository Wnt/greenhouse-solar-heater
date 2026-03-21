# API Contract: Push Notification Endpoints

**Feature**: 004-pwa-push-notifications
**Date**: 2026-03-21

All endpoints are under the existing PoC server (`poc/server.js`). Push API endpoints require authentication when `AUTH_ENABLED=true` (same auth gate as existing `/api/rpc/*` endpoints).

## GET /api/push/vapid-public-key

Returns the VAPID public key that the browser needs to create a push subscription.

**Request**: No body or parameters.

**Response** (200):
```json
{
  "publicKey": "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3..."
}
```

**Response** (503 — push not configured):
```json
{
  "error": "Push notifications not available"
}
```

**Notes**: Returns 503 if VAPID keys could not be loaded/generated (e.g., S3 unavailable and no local fallback). The public key is safe to expose — it is shared with all browsers.

---

## POST /api/push/subscribe

Registers a new push subscription on the server.

**Request body** (JSON):
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/abc123...",
  "keys": {
    "p256dh": "BNcRd...",
    "auth": "tBHI..."
  }
}
```

**Response** (201 — created):
```json
{
  "ok": true
}
```

**Response** (200 — already exists):
```json
{
  "ok": true,
  "existing": true
}
```

**Response** (400 — invalid subscription):
```json
{
  "error": "Invalid subscription: missing endpoint or keys"
}
```

**Behavior**:
- Validates that `endpoint`, `keys.p256dh`, and `keys.auth` are present
- If a subscription with the same `endpoint` already exists, replaces it (idempotent)
- Persists the updated subscriptions array to S3

---

## POST /api/push/unsubscribe

Removes a push subscription from the server.

**Request body** (JSON):
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/abc123..."
}
```

**Response** (200 — removed):
```json
{
  "ok": true
}
```

**Response** (404 — not found):
```json
{
  "error": "Subscription not found"
}
```

**Behavior**:
- Finds and removes the subscription matching the given `endpoint`
- Persists the updated subscriptions array to S3
- Returns 404 if no matching subscription exists (idempotent in practice — client can ignore 404)

---

## Push Notification Payload

Sent from server to push service (not a client-facing API, but documents the notification format).

**Payload** (JSON string, encrypted by web-push library):
```json
{
  "title": "Valve V1 opened",
  "body": "V1 changed to open (auto mode)",
  "tag": "valve-change",
  "data": {
    "valve": "v1",
    "state": "open",
    "mode": "auto",
    "timestamp": "2026-03-21T14:30:00.000Z"
  }
}
```

**Fields**:
| Field | Description |
|-------|-------------|
| title | Human-readable notification title: "Valve {V1\|V2} {opened\|closed}" |
| body | Additional context including operating mode |
| tag | Fixed string "valve-change" — allows browser to collapse/replace same-tag notifications |
| data.valve | Which valve changed: "v1" or "v2" |
| data.state | New state: "open" or "closed" |
| data.mode | Current operating mode: "auto" or "override" |
| data.timestamp | ISO 8601 timestamp of the state change detection |

**Service worker handling**: The `push` event listener in `sw.js` parses the payload and calls `self.registration.showNotification(title, options)`. The `notificationclick` event opens or focuses the monitor app.
