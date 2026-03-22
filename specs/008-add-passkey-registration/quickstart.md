# Quickstart: Add Passkey Registration via Invitation

**Feature Branch**: `008-add-passkey-registration`
**Date**: 2026-03-22

## What This Feature Does

Allows an authenticated user to invite a new device to register a passkey by sharing a 6-digit code or QR code. The new device enters the code on the login page, registers a passkey, and is automatically logged in.

## How to Test

### Prerequisites

- Node.js 20 LTS
- Two devices (or two browser profiles / incognito windows)

### Setup

```bash
# Install dependencies
npm install

# Start the server in auth mode
AUTH_ENABLED=true RPID=localhost ORIGIN=http://localhost:3000 node monitor/server.js
```

### Test Flow

1. **Initial setup**: Open `http://localhost:3000` on Device A. Register the first passkey during the setup window.

2. **Generate invitation**: On Device A (authenticated), click "Add Device". Note the 6-digit code displayed.

3. **Redeem on new device**: On Device B, open `http://localhost:3000/login.html`. Click "Have an invitation code?", enter the 6-digit code, and register a new passkey.

4. **Verify**: Device B should be automatically logged in. Sign out and sign back in on Device B to confirm the passkey works for normal login.

### Run Tests

```bash
npm run test:unit    # Unit tests including invitation logic
npm test             # Full test suite
```

## Key Files

| File | Role |
|------|------|
| `monitor/auth/webauthn.js` | Server-side invitation + registration logic |
| `monitor/auth/credentials.js` | Credential storage (unchanged schema) |
| `monitor/login.html` | Login page with invitation code input |
| `monitor/js/login.js` | Client-side invitation + registration flow |
| `monitor/index.html` | "Add Device" button for generating invitations |
| `monitor/js/app.js` | Invitation generation UI logic |
| `monitor/vendor/qrcode.mjs` | Vendored QR code generator |
| `tests/auth.test.js` | Unit tests for invitation logic |
