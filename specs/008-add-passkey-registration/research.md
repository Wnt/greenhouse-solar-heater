# Research: Add Passkey Registration via Invitation

**Feature Branch**: `008-add-passkey-registration`
**Date**: 2026-03-22

## R1: Invitation Code Storage Strategy

**Decision**: Store invitations in server memory only (not persisted to S3).

**Rationale**: Invitations are short-lived (5-minute expiry) and single-use. The existing system already uses in-memory storage for WebAuthn challenges (`pendingChallenges` object in `webauthn.js`). Invitations follow the same pattern — they are ephemeral authorization tokens, not durable data. A server restart naturally invalidates all pending invitations, which is acceptable and even desirable from a security perspective.

**Alternatives considered**:
- Persist to S3 via credential store: Rejected — adds unnecessary write latency and complexity for data that expires in minutes. Would also violate the single-responsibility of the credentials file.
- Store alongside challenges in `pendingChallenges`: Rejected — invitations have different lifecycle (longer-lived, different validation rules). Separate data structure is cleaner.

**Constitution compliance**: Principle VI (Durable Data Persistence) does NOT apply — invitations are ephemeral authorization tokens, not application data that accumulates over time. Same reasoning applies to WebAuthn challenges which are already stored in memory.

## R2: QR Code Library for Browser-Side Generation

**Decision**: Use `qrcode` npm package (node-qrcode), vendored as a precompiled browser bundle.

**Rationale**: The `qrcode` package provides a precompiled UMD/ESM bundle in `build/` that works directly in browsers without bundlers. It renders to Canvas or returns a data URL, which is sufficient for displaying a QR code. It's widely used (40M+ weekly downloads), well-maintained, and has no runtime dependencies in the browser bundle.

**Alternatives considered**:
- `lean-qr`: Very small (~4kB) but less established and fewer output format options.
- `qrcodejs` (davidshimjs): Popular but unmaintained (last commit 2015), no ESM support.
- Canvas API manual implementation: Too complex, no benefit over a proven library.
- Server-side QR generation: Rejected — adds server complexity unnecessarily when browser can do it.

**Vendoring approach**: Download via `npm pack qrcode`, extract the ESM/UMD browser build file, copy to `monitor/vendor/qrcode.mjs`. Add to importmap in `login.html`. Consistent with existing vendoring pattern (`simplewebauthn-browser.mjs`).

## R3: Invitation Code Format and Security

**Decision**: 6-digit numeric code (000000–999999), cryptographically random.

**Rationale**: With 1,000,000 possible codes, a 5-minute expiry window, and rate limiting (5 attempts/minute/client), brute force is impractical. The code needs to be easy to read aloud, type on a phone, and display in a QR code. Numeric-only avoids ambiguity (O vs 0, I vs 1 vs l).

**Security analysis**:
- At 5 attempts/minute, exhausting 1M codes takes 200,000 minutes (~139 days)
- Code is single-use: once redeemed, it's consumed
- Only one active invitation at a time per session
- Generated using `crypto.randomInt()` for uniform distribution

**Alternatives considered**:
- 8-digit alphanumeric: More entropy but harder to type on mobile, harder to read aloud.
- UUID: Too long to type manually, only useful for QR/link flow.
- 4-digit code: Too few combinations (10,000) — feasible to brute-force even with rate limiting.

## R4: Rate Limiting Strategy

**Decision**: In-memory rate limiting per client IP, 5 attempts per minute for invitation validation.

**Rationale**: Simple sliding window counter per IP address. Resets after 1 minute of no attempts. Stored in memory (no persistence needed). The server is single-instance, so in-memory tracking is sufficient.

**Implementation approach**: Track `{ ip: { attempts: [], lastCleanup: timestamp } }` map. On each validation attempt, filter out attempts older than 60 seconds, check if count >= 5.

**Alternatives considered**:
- Token bucket algorithm: Unnecessarily complex for this use case.
- External rate limiter (Redis): No Redis in the stack, overkill for single-instance server.
- No rate limiting: Unacceptable — 6-digit codes could be brute-forced within the expiry window.

## R5: Invitation UI Placement

**Decision**:
- **Generation**: "Add Device" button on the main monitor page (index.html), visible only to authenticated users. Opens a modal/overlay showing the code and QR.
- **Redemption**: "Have an invitation code?" link on the login page (login.html), below the "Sign in with Passkey" button. Expands to show a 6-digit input field.

**Rationale**: Generation belongs in the main app (where authenticated users are). Redemption belongs on the login page (where unauthenticated users on new devices land). This avoids creating a separate page and keeps the flow natural.

**Alternatives considered**:
- Separate `/invite.html` page: Rejected — adds file bloat when the login page can handle both states.
- Settings page: No settings page exists; creating one for a single button is overkill.

## R6: Registration Flow with Invitation

**Decision**: Reuse the existing WebAuthn registration flow (`/auth/register/options` + `/auth/register/verify`) with an added `invitationCode` parameter.

**Rationale**: The registration logic (challenge generation, attestation verification, credential storage) is identical whether registering during setup, as an authenticated user, or via invitation. The only difference is the authorization check: instead of checking `isRegistrationOpen() || isAuthenticated()`, also check `isValidInvitation(code)`.

**Flow**:
1. New device: `POST /auth/invite/validate` with `{ code: "123456" }` — validates code, returns success/error
2. If valid: `POST /auth/register/options` with `{ invitationCode: "123456" }` — generates challenge (invitation authorizes this)
3. Browser prompts for passkey creation
4. `POST /auth/register/verify` with attestation + `{ invitationCode: "123456" }` — verifies, stores credential, marks invitation used, creates session

**Alternatives considered**:
- Separate registration endpoints for invitation flow: Rejected — duplicates logic.
- Two-step: validate then register in separate flows: Adopted partially — validate first to show good UX before triggering browser passkey prompt.
