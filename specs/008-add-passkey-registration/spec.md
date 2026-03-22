# Feature Specification: Add Passkey Registration via Invitation

**Feature Branch**: `008-add-passkey-registration`
**Created**: 2026-03-22
**Status**: Draft
**Input**: User description: "add a feature where I can register another passkey authenticated to the system. I think we could do a QR or numeric token share from an earlier established session to link a new device/passkey"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generate Invitation from Authenticated Session (Priority: P1)

An authenticated user wants to add a new device (e.g., a phone or tablet) to their account. From the monitor web UI on their already-authenticated device, they initiate an invitation that produces a short numeric code and a QR code. The code is time-limited and single-use.

**Why this priority**: This is the core enabler — without generating an invitation, no new device can be added outside the initial setup window.

**Independent Test**: Can be fully tested by logging in on one device, generating an invitation code, and verifying the code and QR are displayed. Delivers value by giving the user a shareable credential.

**Acceptance Scenarios**:

1. **Given** the user is authenticated, **When** they tap "Add Device", **Then** the system displays a short numeric code and a QR code encoding the same invitation.
2. **Given** an invitation is generated, **When** the configured time limit expires, **Then** the invitation becomes invalid and cannot be used.
3. **Given** an invitation is generated, **When** the user generates a new invitation, **Then** any previously unused invitation from that session is invalidated.

---

### User Story 2 - Register Passkey on New Device via Invitation Code (Priority: P1)

A user opens the monitor login page on a new device (not yet authenticated). Instead of being blocked, they see an option to enter an invitation code. After entering the valid code, the system prompts them to register a passkey on the new device, and upon success they are automatically logged in.

**Why this priority**: This completes the invitation flow — without redemption, invitation generation has no value. Equally critical as Story 1.

**Independent Test**: Can be tested by navigating to the login page on a new device, entering a valid invitation code, completing passkey registration, and verifying automatic login and access to the monitor.

**Acceptance Scenarios**:

1. **Given** the user is on the login page of an unauthenticated device, **When** they tap "Use Invitation Code", **Then** they see a numeric code input field.
2. **Given** a valid invitation code is entered, **When** the system verifies it, **Then** the user is prompted to register a new passkey on the device.
3. **Given** passkey registration succeeds, **When** the credential is stored, **Then** the user is automatically logged in and redirected to the monitor.
4. **Given** an invalid or expired code is entered, **When** the system verifies it, **Then** an error message is shown and no registration occurs.

---

### User Story 3 - Register Passkey on New Device via QR Code (Priority: P2)

A user scans the QR code displayed on their authenticated device using the new device's camera. The QR code opens the monitor login page with the invitation pre-filled, and the user is prompted to register a passkey without manually typing the code.

**Why this priority**: QR is a convenience improvement over manual numeric entry. The system works without it (via manual code entry), but QR significantly improves the experience for phone-to-phone or laptop-to-phone flows.

**Independent Test**: Can be tested by scanning the QR from a new device, verifying the login page opens with the code pre-filled, and completing passkey registration.

**Acceptance Scenarios**:

1. **Given** the QR code is displayed on the authenticated device, **When** the user scans it with a new device, **Then** the monitor login page opens with the invitation code pre-filled.
2. **Given** the login page opens with a pre-filled code, **When** the code is valid, **Then** the passkey registration prompt appears automatically.

---

### Edge Cases

- What happens when the invitation code is used on the same device that generated it? The system allows it — the user may want to add a second passkey on the same device.
- What happens if the server restarts while an invitation is active? The invitation is invalidated (stored in memory only, consistent with existing challenge storage pattern).
- What happens if the user cancels the passkey registration prompt after entering a valid code? The invitation remains valid for retry until it expires or is used.
- What happens if someone brute-forces invitation codes? Rate limiting and code complexity make brute-force impractical within the expiry window.
- What happens if the authenticated user's session expires while the invitation is still active? The invitation remains valid independently — it was already authorized at creation time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an authenticated user to generate a time-limited, single-use invitation code from the monitor UI.
- **FR-002**: System MUST display the invitation as both a short numeric code (6 digits) and a QR code on the authenticated device's screen.
- **FR-003**: System MUST provide a "Use Invitation Code" option on the login page for unauthenticated users.
- **FR-004**: System MUST validate the invitation code before allowing passkey registration (check existence, expiry, and single-use status).
- **FR-005**: System MUST invalidate an invitation after successful use (single-use).
- **FR-006**: System MUST invalidate an invitation after its time limit expires (default: 5 minutes).
- **FR-007**: System MUST automatically log in the new device after successful passkey registration via invitation.
- **FR-008**: QR code MUST encode a URL that opens the login page with the invitation code as a parameter.
- **FR-009**: System MUST invalidate any previous unused invitation when a new one is generated from the same session.
- **FR-010**: System MUST limit the rate of invitation code verification attempts to prevent brute-force attacks (max 5 attempts per minute per client).
- **FR-011**: The new passkey MUST be added to the existing single user's credential list (consistent with the system's single-user model).

### Key Entities

- **Invitation**: A time-limited, single-use token that authorizes passkey registration. Key attributes: code (6-digit numeric), expiry time, used/unused status, creating session identifier.
- **Passkey Credential**: An existing entity — the new passkey registered via invitation is stored identically to passkeys registered during initial setup or by authenticated users.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can add a new device passkey within 60 seconds of initiating the invitation flow (from tapping "Add Device" to completing registration on the new device).
- **SC-002**: Invitation codes expire and become unusable after the configured time limit (5 minutes default).
- **SC-003**: Each invitation code can only be used once — subsequent attempts with the same code are rejected.
- **SC-004**: 100% of passkeys registered via invitation work identically to passkeys registered during initial setup for subsequent logins.
- **SC-005**: Brute-force attempts against invitation codes are blocked after 5 failed attempts within one minute.

## Assumptions

- The system remains single-user; this feature adds additional passkeys (devices) for the same user, not new user accounts.
- 6-digit numeric codes provide sufficient entropy for the short expiry window (1,000,000 combinations with 5-minute expiry and rate limiting).
- QR code generation is done client-side in the browser (no server-side image generation needed).
- Invitations are stored in server memory only (not persisted to S3), consistent with the existing pattern for WebAuthn challenges.
- The existing vendored `@simplewebauthn/browser` library handles the new device's passkey registration (no new client dependencies for WebAuthn).
