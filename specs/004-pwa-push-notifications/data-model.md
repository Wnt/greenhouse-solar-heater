# Data Model: PWA Push Notifications

**Feature**: 004-pwa-push-notifications
**Date**: 2026-03-21

## Entities

### PushSubscription

Represents a single browser/device subscription for receiving push notifications.

| Field | Type | Description |
|-------|------|-------------|
| endpoint | string (URL) | Push service endpoint URL, unique per subscription |
| keys.p256dh | string (base64url) | User agent public encryption key |
| keys.auth | string (base64url) | User agent authentication secret |

**Storage**: JSON array in S3 key `push-subscriptions.json`

**Lifecycle**:
- Created when user subscribes via browser Push API
- Removed when user unsubscribes, or when push delivery returns 404/410
- Deduplicated by `endpoint` URL (re-subscribing from same browser replaces existing entry)

**Example**:
```json
[
  {
    "endpoint": "https://fcm.googleapis.com/fcm/send/abc123...",
    "keys": {
      "p256dh": "BNcRd...",
      "auth": "tBHI..."
    }
  }
]
```

### VAPIDConfig

Server authentication configuration for the Web Push protocol.

| Field | Type | Description |
|-------|------|-------------|
| publicKey | string (base64url) | VAPID public key, shared with browsers |
| privateKey | string (base64url) | VAPID private key, server-only |
| subject | string (mailto: URI) | Contact URI for the application operator |

**Storage**: JSON object in S3 key `push-config.json`

**Lifecycle**:
- Generated once on first server startup if not found in S3
- Persisted permanently — changing keys invalidates all existing subscriptions
- Read on every server startup to configure the web-push library

**Example**:
```json
{
  "publicKey": "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3...",
  "privateKey": "UUxI4o8-C1lA7etiEcWqC34F0nEJE...",
  "subject": "mailto:greenhouse@example.com"
}
```

### ValveState

In-memory representation of the current valve positions, used for change detection.

| Field | Type | Description |
|-------|------|-------------|
| v1 | boolean | Valve 1 state (true = open, false = closed) |
| v2 | boolean | Valve 2 state (true = open, false = closed) |
| mode | string | Operating mode: "auto" or "override" |
| timestamp | string (ISO 8601) | When this state was observed |

**Storage**: In-memory only (not persisted). Reset on server restart. First poll after restart establishes baseline without triggering notifications.

**State Transitions**:
```
[Server Start] → first poll → store as baseline (no notification)
                → subsequent polls → compare with previous:
                    v1 changed? → push notification "V1 opened/closed"
                    v2 changed? → push notification "V2 opened/closed"
                    → update stored state
[Poll Error]   → retain previous state, skip comparison (no spurious notifications)
```

## Relationships

```
VAPIDConfig (1) ──── authenticates ────▶ (many) PushSubscription
PushSubscription (many) ◀──── receives ──── (1) ValveState change event
```

- VAPIDConfig is a singleton — one key pair for the entire application
- PushSubscriptions are a small collection (1-5 entries for single user, multiple devices)
- ValveState is ephemeral — exists only in server memory during runtime
