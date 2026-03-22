# Implementation Plan: Add Passkey Registration via Invitation

**Branch**: `008-add-passkey-registration` | **Date**: 2026-03-22 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/008-add-passkey-registration/spec.md`

## Summary

Add an invitation-based passkey registration flow that allows an authenticated user to share a 6-digit code (displayed as numeric text + QR code) from their device to authorize passkey registration on a new device. The invitation is time-limited (5 minutes), single-use, and rate-limited against brute force. The new passkey is added to the existing single-user credential list.

## Technical Context

**Language/Version**: Node.js 20 LTS (CommonJS server-side), ES6+ browser modules
**Primary Dependencies**: `@simplewebauthn/server` (existing), `@simplewebauthn/browser` (vendored, existing), `qrcode` (new, vendored browser bundle for QR generation)
**Storage**: S3-compatible object storage for credentials (existing, unchanged schema); in-memory for invitations and rate limits
**Testing**: `node:test` (unit tests), Playwright (e2e)
**Target Platform**: Node.js server + modern browsers (Chrome, Safari, Firefox)
**Project Type**: Web application (monitor)
**Performance Goals**: Invitation generation < 100ms, code validation < 50ms
**Constraints**: Single-instance server, no external rate limiting infrastructure
**Scale/Scope**: Single user, 1-2 concurrent devices, ~1 invitation per week expected usage

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Status | Notes |
|-----------|----------|--------|-------|
| I. Hardware Spec as SSOT | No | N/A | Software-only feature, no hardware changes |
| II. Pure Logic / IO Separation | Partially | PASS | Invitation validation and rate limiting are pure functions (no I/O). Route handlers perform I/O (HTTP responses). Consistent with existing `webauthn.js` pattern. |
| III. Safe by Default (NON-NEGOTIABLE) | Yes | PASS | Invitations default to expired/invalid. Rate limiting blocks brute force by default. Registration requires explicit valid invitation. No silent unsafe behavior. |
| IV. Proportional Test Coverage | Yes | PASS | Unit tests for invitation CRUD, rate limiting, expiry. E2e coverage of the invitation flow. |
| V. Token-Based Cloud Auth | No | N/A | No UpCloud API interaction |
| VI. Durable Data Persistence | Yes | PASS | Invitations are ephemeral authorization tokens (like WebAuthn challenges), not persistent application data. Credentials stored via existing S3 adapter. See [research.md R1](research.md). |

**Post-design re-check**: All gates pass. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/008-add-passkey-registration/
├── plan.md              # This file
├── research.md          # Phase 0: decisions on storage, QR lib, code format, rate limiting
├── data-model.md        # Phase 1: Invitation entity, rate limit entry, state transitions
├── quickstart.md        # Phase 1: test flow and key files
├── contracts/
│   └── api.md           # Phase 1: new + modified auth endpoints
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
monitor/
├── auth/
│   └── webauthn.js          # Modified: invitation CRUD, rate limiting, updated registration auth check
├── js/
│   ├── login.js             # Modified: invitation code input, invite-based registration flow
│   └── app.js               # Modified: "Add Device" button, invitation generation UI
├── vendor/
│   └── qrcode.mjs           # New: vendored QR code browser library
├── login.html               # Modified: invitation code input section, qrcode importmap entry
├── index.html               # Modified: "Add Device" button/section
├── server.js                # Modified: add qrcode.mjs to public routes
└── css/style.css            # Modified: invitation UI styles (modal, code display, input)

tests/
└── auth.test.js             # Modified: invitation CRUD, rate limiting, expiry tests
```

**Structure Decision**: All changes fit within the existing `monitor/` directory structure. No new directories needed except the vendored QR library file. The feature extends the existing auth module (`webauthn.js`) rather than creating a new module, because invitation management is tightly coupled with registration authorization.
