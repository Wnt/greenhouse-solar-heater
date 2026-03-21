# Auth Endpoint Contracts (Existing)

These endpoints already exist and are **not modified** by this feature. Documented here for reference by the client-side implementation.

## GET /auth/status

**Purpose**: Check authentication state.

**Request**: No body. Session cookie sent automatically.

**Response** (200):
```json
{
  "authenticated": true,
  "setupMode": false,
  "registrationOpen": true
}
```

**When auth is disabled**: Endpoint is not registered; returns 404.

## POST /auth/logout

**Purpose**: End the current session.

**Request**: No body. Session cookie sent automatically.

**Response** (200):
```json
{
  "ok": true
}
```

**Side effects**:
- Removes session token from server-side store
- Sets `session` cookie `Max-Age=0` (clears it)

**When no session exists**: Still returns `{ ok: true }` and clears cookie (idempotent).
