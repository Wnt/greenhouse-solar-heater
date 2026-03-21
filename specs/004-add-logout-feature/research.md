# Research: Add Logout Feature

**Feature**: 004-add-logout-feature
**Date**: 2026-03-21

## Research Findings

### 1. Existing Server-Side Logout Support

**Decision**: Use the existing `POST /auth/logout` endpoint — no server changes needed for the core logout flow.

**Rationale**: The endpoint in `poc/auth/webauthn.js` already:
- Extracts the session token from the request cookie
- Removes the session from the credential store
- Clears the session cookie (sets `Max-Age=0`)
- Returns `{ ok: true }`

**Alternatives considered**: None — the endpoint is complete and functional.

### 2. Auth Status Detection for Conditional Button Visibility

**Decision**: Use `GET /auth/status` to detect whether the user is authenticated, then show/hide the logout button accordingly.

**Rationale**: The `/auth/status` endpoint returns `{ authenticated, setupMode, registrationOpen }` and is accessible without authentication. When auth is disabled on the server, `AUTH_ENABLED=false` means `/auth/` routes are not registered, so the fetch will 404. This 404 itself serves as a reliable signal that auth is disabled — no logout button needed.

**Alternatives considered**:
- Server-rendered flag (e.g., inject `data-auth-enabled` into HTML): Would require server-side HTML templating, which the PoC doesn't use (static file serving).
- Separate `/api/config` endpoint: Over-engineering for a single boolean.

### 3. Button Placement and Styling

**Decision**: Place logout button inside `.page-header nav`, after the Playground link. Style it to match existing nav link appearance.

**Rationale**: The header nav already uses flexbox with gap spacing. Adding another element requires zero layout changes. Using the same visual style as the Playground link (padding `6px 12px`, border-radius `6px`) keeps the UI consistent. A `<button>` element is semantically correct for an action (vs `<a>` for navigation).

**Alternatives considered**:
- Separate header section: Unnecessary complexity.
- Icon-only button: Less accessible, unclear meaning for first-time users.
- Dropdown menu: Over-engineering for a single action.

### 4. Auth-Awareness in app.js

**Decision**: Add a lightweight auth check at app init time. Call `/auth/status` once on page load. If authenticated, show the logout button and wire up the click handler.

**Rationale**: The app currently has zero auth awareness. A single fetch on init is minimal overhead. The response drives button visibility. No polling needed — auth state doesn't change during a session unless the user explicitly logs out.

**Alternatives considered**:
- Check on every sensor poll: Wasteful, unnecessary.
- Use a cookie-presence check: Cookies are HttpOnly, so JS can't read them.

### 5. Error Handling for Logout

**Decision**: On logout failure, show a brief error message near the button and keep the user on the page. On success, redirect to `/login.html`.

**Rationale**: Network errors are transient. Keeping the user on the page lets them retry. The existing login page is the natural landing after logout.

### 6. Server Behavior When Auth Is Disabled

**Decision**: When `AUTH_ENABLED=false`, the server doesn't register `/auth/` routes, so `GET /auth/status` returns 404. The client treats any non-200 response from `/auth/status` as "auth disabled" and hides the logout button.

**Rationale**: This requires no server modification. The absence of the auth routes is the signal.

### 7. Test Strategy

**Decision**: Add proportional tests per Constitution Principle IV:
- **Unit test**: Test that the logout endpoint clears session and cookie (extend `tests/auth.test.js`)
- **E2e test**: Playwright test for the logout button visibility and click behavior

**Rationale**: The UI change is small but affects security-relevant behavior. Unit tests verify the server-side contract. E2e tests verify the user-facing flow.
