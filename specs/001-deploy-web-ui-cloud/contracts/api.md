# API Contracts: Deploy PoC Web UI to Cloud

**Feature Branch**: `001-deploy-web-ui-cloud`
**Date**: 2026-03-20

## Authentication Endpoints

All endpoints return JSON. All non-auth endpoints require a valid session cookie.

### POST /auth/register/options

Generate WebAuthn registration options (only available during setup window).

**Request**: Empty body
**Response** (200):
```json
{
  "challenge": "<base64url>",
  "rp": { "name": "Shelly Monitor", "id": "example.com" },
  "user": { "id": "<base64url>", "name": "admin", "displayName": "Admin" },
  "pubKeyCredParams": [{ "alg": -7, "type": "public-key" }],
  "timeout": 60000,
  "authenticatorSelection": {
    "residentKey": "preferred",
    "userVerification": "preferred"
  }
}
```
**Error** (403): `{ "error": "Registration window closed" }`

### POST /auth/register/verify

Complete passkey registration.

**Request**:
```json
{
  "id": "<base64url>",
  "rawId": "<base64url>",
  "response": {
    "attestationObject": "<base64url>",
    "clientDataJSON": "<base64url>"
  },
  "type": "public-key"
}
```
**Response** (200): `{ "verified": true }` + Set-Cookie with session token
**Error** (400): `{ "error": "Verification failed" }`
**Error** (403): `{ "error": "Registration window closed" }`

### POST /auth/login/options

Generate WebAuthn authentication options.

**Request**: Empty body
**Response** (200):
```json
{
  "challenge": "<base64url>",
  "timeout": 60000,
  "rpId": "example.com",
  "userVerification": "preferred",
  "allowCredentials": [
    { "id": "<base64url>", "type": "public-key", "transports": ["internal"] }
  ]
}
```
**Error** (404): `{ "error": "No credentials registered" }`

### POST /auth/login/verify

Complete passkey authentication.

**Request**:
```json
{
  "id": "<base64url>",
  "rawId": "<base64url>",
  "response": {
    "authenticatorData": "<base64url>",
    "clientDataJSON": "<base64url>",
    "signature": "<base64url>"
  },
  "type": "public-key"
}
```
**Response** (200): `{ "verified": true }` + Set-Cookie with session token
**Error** (401): `{ "error": "Authentication failed" }`

### GET /auth/status

Check current auth state.

**Response** (200):
```json
{
  "authenticated": true,
  "setupMode": false,
  "registrationOpen": false
}
```

### POST /auth/logout

Clear session.

**Response** (200): `{ "ok": true }` + Clear-Cookie

## Existing Proxy Endpoints (Unchanged)

### GET /api/rpc/{method}

Proxy RPC calls to Shelly devices. Requires valid session cookie.

**Query Parameters**:
- `_host` (required): Shelly device IP address
- Additional params forwarded to Shelly device

**Response**: Shelly device JSON response (proxied)
**Error** (401): `{ "error": "Not authenticated" }`
**Error** (502): `{ "error": "Device unreachable: <message>" }`

## Static Assets

### GET /

Redirects to `/login.html` if not authenticated, serves `index.html` if authenticated.

### GET /login.html

Login page with passkey authentication UI. Accessible without authentication.

### GET /health

Health check endpoint (no auth required). Used by Docker healthcheck and potential future monitoring.

**Response** (200):
```json
{
  "status": "ok",
  "vpn": "connected",
  "timestamp": "2026-03-20T12:00:00Z"
}
```
**Response** (200, degraded):
```json
{
  "status": "degraded",
  "vpn": "disconnected",
  "timestamp": "2026-03-20T12:00:00Z"
}
```

## Session Cookie

- **Name**: `session`
- **Value**: HMAC-signed token (`token.signature`)
- **Flags**: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, `Max-Age=2592000` (30 days)
