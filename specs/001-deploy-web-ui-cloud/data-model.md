# Data Model: Deploy PoC Web UI to Cloud

**Feature Branch**: `001-deploy-web-ui-cloud`
**Date**: 2026-03-20

## Entities

### PasskeyCredential

Represents a registered WebAuthn public key credential for the owner.

| Field | Type | Description |
|-------|------|-------------|
| id | string (base64url) | Credential ID assigned by the authenticator |
| publicKey | string (base64url) | Public key for signature verification |
| counter | integer | Signature counter (monotonically increasing, detects cloning) |
| transports | string[] | Transport hints (e.g., "internal", "hybrid", "usb") |
| createdAt | ISO 8601 string | When the credential was registered |

**Identity**: `id` is globally unique (assigned by the authenticator).
**Lifecycle**: Created during registration, counter updated on each authentication, never modified otherwise. Deleted only via explicit revocation (future feature).

### User

Single-user entity representing the greenhouse owner.

| Field | Type | Description |
|-------|------|-------------|
| id | string (base64url) | Random user handle (generated once, never changes) |
| name | string | Display name (e.g., "admin") |
| credentials | PasskeyCredential[] | Registered passkeys for this user |

**Identity**: `id` is a random opaque handle (not PII). Only one user exists.
**Lifecycle**: Created on first passkey registration, persists indefinitely.

### Session

Authenticated session after successful passkey verification.

| Field | Type | Description |
|-------|------|-------------|
| token | string | Random session token (cryptographically secure) |
| createdAt | ISO 8601 string | Session creation time |
| expiresAt | ISO 8601 string | Session expiry (createdAt + 30 days) |

**Identity**: `token` is unique per session.
**Lifecycle**: Created on successful authentication, validated on each request, expired after 30 days. Only one active session expected (single user), but multiple are technically possible (different devices).

### SetupState

Tracks whether the system is in its initial registration window.

| Field | Type | Description |
|-------|------|-------------|
| deployedAt | ISO 8601 string | When the server first started with no credentials |
| registrationOpen | boolean | Whether the 30-minute registration window is active |

**Lifecycle**: Created on first server start when no credentials exist. `registrationOpen` set to `false` after first credential is registered or after 30 minutes, whichever comes first. Never reopened.

## Storage

All data stored in a single JSON file (`poc/auth/credentials.json`):

```json
{
  "user": {
    "id": "<base64url>",
    "name": "admin"
  },
  "credentials": [
    {
      "id": "<base64url>",
      "publicKey": "<base64url>",
      "counter": 42,
      "transports": ["internal", "hybrid"],
      "createdAt": "2026-03-20T12:00:00Z"
    }
  ],
  "sessions": [
    {
      "token": "<hex>",
      "createdAt": "2026-03-20T12:00:00Z",
      "expiresAt": "2026-04-19T12:00:00Z"
    }
  ],
  "setup": {
    "deployedAt": "2026-03-20T12:00:00Z",
    "registrationOpen": false
  }
}
```

File is created at runtime (not checked into git). Read on server start, written after each state change (registration, login, session expiry cleanup).

## Relationships

```
User (1) ──has many──► PasskeyCredential (1..n)
User (1) ──has many──► Session (0..n)
Server ──has one──► SetupState
```

## No External Data Dependencies

The auth data model is self-contained. Shelly device data (temperatures, valve states) flows through the existing RPC proxy and is not persisted on the cloud server.
