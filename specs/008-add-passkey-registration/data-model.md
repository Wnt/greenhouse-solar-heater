# Data Model: Add Passkey Registration via Invitation

**Feature Branch**: `008-add-passkey-registration`
**Date**: 2026-03-22

## New Entities

### Invitation

A time-limited, single-use authorization token that allows passkey registration on a new device.

| Field | Type | Description |
|-------|------|-------------|
| code | string (6-digit numeric) | The invitation code displayed to the user |
| createdAt | integer (Unix ms) | When the invitation was created |
| expiresAt | integer (Unix ms) | When the invitation expires (createdAt + 5 minutes) |
| sessionToken | string | Session token of the authenticated user who created the invitation |

**Identity**: `code` is unique among active (non-expired) invitations.
**Lifecycle**: Created by authenticated user request. Consumed (deleted) on successful passkey registration. Automatically invalid after `expiresAt`. Replaced when the same session creates a new invitation.

### RateLimitEntry

In-memory tracking of invitation validation attempts per client.

| Field | Type | Description |
|-------|------|-------------|
| ip | string | Client IP address |
| attempts | integer[] (Unix ms) | Timestamps of recent validation attempts |

**Identity**: Keyed by client IP address.
**Lifecycle**: Created on first validation attempt. Entries older than 60 seconds are pruned on each check. No persistence.

## Existing Entities (Unchanged)

### PasskeyCredential

No schema changes. Credentials registered via invitation are stored identically to those registered during setup or by authenticated users.

### User

No changes. Single-user model preserved.

### Session

No changes. A new session is created for the new device after successful invitation-based registration, using the existing `createSession()` function.

### SetupState

No changes. The invitation flow is independent of the initial setup window.

## Storage

### Invitations — In-Memory Only

Invitations are stored in a JavaScript object in the `webauthn.js` module, similar to the existing `pendingChallenges` pattern:

```javascript
// Active invitations, keyed by code
var activeInvitations = {};

// Example state:
{
  "847293": {
    code: "847293",
    createdAt: 1711108800000,
    expiresAt: 1711109100000,  // +5 minutes
    sessionToken: "a1b2c3..."
  }
}
```

**Not persisted to S3.** Invitations are ephemeral — a server restart clears all pending invitations. This is consistent with the existing challenge storage pattern and is acceptable because:
- Invitations expire in 5 minutes anyway
- Users can generate a new invitation at any time
- No data loss — only a minor inconvenience if restart happens during the 5-minute window

### Rate Limiting — In-Memory Only

```javascript
// Rate limit tracking, keyed by IP
var rateLimits = {};

// Example state:
{
  "192.168.1.100": {
    attempts: [1711108800000, 1711108805000, 1711108810000]
  }
}
```

### Credentials File — No Schema Changes

The existing `credentials.json` (S3 or local) is not modified. New passkeys are added to the `credentials` array using the existing `addCredential()` function.

## Relationships

```
User (1) ──has many──► PasskeyCredential (1..n)
User (1) ──has many──► Session (0..n)
Session (1) ──creates──► Invitation (0..1)     [NEW]
Invitation (1) ──authorizes──► PasskeyCredential [NEW, on redemption]
Server ──has one──► SetupState
```

## State Transitions

### Invitation Lifecycle

```
                    ┌─────────────────────┐
                    │  (does not exist)    │
                    └──────────┬──────────┘
                               │ POST /auth/invite/create
                               │ (authenticated user)
                               ▼
                    ┌─────────────────────┐
           ┌───────│      Active          │───────┐
           │       └──────────┬──────────┘        │
           │                  │                    │
           │ 5 min expires    │ POST /auth/        │ New invitation
           │                  │ register/verify    │ from same session
           ▼                  ▼                    ▼
    ┌────────────┐   ┌────────────────┐   ┌──────────────┐
    │  Expired   │   │   Consumed     │   │  Replaced    │
    │ (deleted)  │   │   (deleted)    │   │  (deleted)   │
    └────────────┘   └────────────────┘   └──────────────┘
```

All terminal states result in the invitation being removed from the in-memory store.
