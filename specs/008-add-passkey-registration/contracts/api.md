# API Contracts: Add Passkey Registration via Invitation

**Feature Branch**: `008-add-passkey-registration`
**Date**: 2026-03-22

## New Endpoints

### POST /auth/invite/create

Generate a new invitation code. Requires authenticated session.

**Request**: Empty body
**Response** (200):
```json
{
  "code": "847293",
  "expiresAt": "2026-03-22T12:05:00Z",
  "expiresInSeconds": 300
}
```
**Error** (401): `{ "error": "Not authenticated" }`

**Side effects**:
- Invalidates any existing invitation created by the same session
- Stores new invitation in server memory

---

### POST /auth/invite/validate

Check whether an invitation code is valid. Does not consume the invitation.

**Request**:
```json
{
  "code": "847293"
}
```
**Response** (200): `{ "valid": true }`
**Error** (400): `{ "error": "Invalid or expired invitation code" }`
**Error** (429): `{ "error": "Too many attempts. Try again later." }`

**Rate limiting**: Max 5 attempts per minute per client IP. Returns 429 when exceeded.

---

## Modified Endpoints

### POST /auth/register/options

**Change**: Accepts optional `invitationCode` in request body. Registration is now authorized if ANY of these conditions are true:
1. Registration window is open (initial setup — existing behavior)
2. Request has a valid authenticated session (existing behavior)
3. Request includes a valid, non-expired `invitationCode`

**Request** (updated):
```json
{
  "invitationCode": "847293"
}
```
Or empty body (existing behavior for setup window / authenticated users).

**Response** (200): Unchanged — returns WebAuthn registration options.
**Error** (403): `{ "error": "Registration not allowed" }` (no valid authorization)
**Error** (429): `{ "error": "Too many attempts. Try again later." }` (rate limit on invitation code)

---

### POST /auth/register/verify

**Change**: Accepts optional `invitationCode` in request body. If present and valid, the invitation is consumed on successful verification.

**Request** (updated):
```json
{
  "id": "<base64url>",
  "rawId": "<base64url>",
  "response": {
    "attestationObject": "<base64url>",
    "clientDataJSON": "<base64url>"
  },
  "type": "public-key",
  "invitationCode": "847293"
}
```

**Response** (200): `{ "verified": true }` + Set-Cookie with session token (unchanged)
**Error** (400): `{ "error": "Verification failed" }` (unchanged)
**Error** (403): `{ "error": "Registration not allowed" }` (invitation expired between options and verify)

**Side effects** (in addition to existing):
- Marks invitation as consumed (deletes from memory)

---

### GET /auth/status

**Change**: No schema change. The `registrationOpen` field continues to reflect only the initial setup window state. Invitation availability is checked separately via `/auth/invite/validate`.

---

## Unchanged Endpoints

The following endpoints are not modified:

- `POST /auth/login/options` — unchanged
- `POST /auth/login/verify` — unchanged
- `POST /auth/logout` — unchanged
- `GET /health` — unchanged
- `GET /api/rpc/{method}` — unchanged

## Public Routes Update

The following routes do NOT require authentication:

- `/auth/*` — all auth endpoints (existing)
- `/login.html` — login page (existing)
- `/js/login.js` — login script (existing)
- `/vendor/simplewebauthn-browser.mjs` — WebAuthn browser lib (existing)
- `/vendor/qrcode.mjs` — QR code generator (NEW)
- `/css/style.css` — styles (existing)

## Session Cookie

No changes. The session cookie format and behavior remain identical:

- **Name**: `session`
- **Value**: HMAC-signed token (`token.signature`)
- **Flags**: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, `Max-Age=2592000` (30 days)
