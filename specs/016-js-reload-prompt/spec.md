# Feature Specification: JS Reload Prompt

**Feature Branch**: `016-js-reload-prompt`
**Created**: 2026-03-31
**Status**: Draft
**Input**: User description: "Add a feature to the greenhouse.madekivi.fi app that prompts the user to reload / refresh the page when we notice that the client-side js sources on the server have been updated. Use editorial style language"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Notified of Available Update (Priority: P1)

A user has the greenhouse dashboard open in their browser. While they are viewing or idling on the page, the application's client-side code is updated on the server (e.g., after a new deployment). The app quietly detects that the scripts it loaded are no longer current and presents a polished, unobtrusive prompt inviting the user to refresh. The language is warm and editorial in tone — more "a fresh edition is ready" than "version mismatch detected."

**Why this priority**: This is the core of the feature. Without the detection and prompt, nothing else matters.

**Independent Test**: Can be fully tested by deploying a change to any JS module and verifying the prompt appears in an already-open browser session within the polling interval.

**Acceptance Scenarios**:

1. **Given** the user has the page open with version A of the scripts, **When** version B is deployed to the server, **Then** a prompt appears within the next check interval inviting the user to refresh.
2. **Given** the user has the page open and no update has occurred, **When** the background check runs, **Then** no prompt is shown and the experience is undisturbed.
3. **Given** the prompt is visible, **When** the user chooses to refresh, **Then** the page reloads and the user sees the updated application.

---

### User Story 2 - Dismissing the Prompt (Priority: P2)

A user sees the update prompt but is in the middle of reviewing data or adjusting controls. They dismiss the prompt to continue their current task. The prompt does not reappear immediately — it waits until the next check cycle confirms the update is still available before gently resurfacing.

**Why this priority**: Respecting user attention is essential. A prompt that cannot be dismissed or that reappears instantly would be disruptive.

**Independent Test**: Can be tested by triggering the prompt, dismissing it, and verifying it does not reappear until after the next polling interval.

**Acceptance Scenarios**:

1. **Given** the update prompt is displayed, **When** the user dismisses it, **Then** the prompt disappears and the user can continue uninterrupted.
2. **Given** the user has dismissed the prompt, **When** the next check cycle detects the update is still available, **Then** the prompt reappears after the full interval has elapsed.

---

### User Story 3 - Prompt Appearance and Tone (Priority: P2)

The prompt fits the application's existing dark editorial aesthetic (the Stitch design system). It uses serif or editorial-style language — understated, confident, and inviting. It appears as a subtle banner or toast that complements the dashboard rather than interrupting it.

**Why this priority**: The editorial tone is an explicit requirement and the app has a strong visual identity. The prompt must feel native.

**Independent Test**: Can be tested by triggering the prompt and visually inspecting that it matches the Stitch dark theme (dark background, gold primary, teal secondary, Newsreader/Manrope typography) and uses editorial language.

**Acceptance Scenarios**:

1. **Given** an update is detected, **When** the prompt appears, **Then** it uses language that is warm and editorial (e.g., "A fresh edition is available. Refresh to see the latest.") rather than technical jargon.
2. **Given** the prompt is displayed, **When** viewed alongside the dashboard, **Then** it visually matches the Stitch design system (color palette, typography, dark theme) and does not obscure critical information.

---

### Edge Cases

- What happens when the user is offline or the server is unreachable during a check? The check silently fails and retries at the next interval — no error is shown.
- What happens if the version check response is malformed or unexpected? The check treats it as "no update" and retries next cycle.
- What happens on the login page? The version check runs only on the main application page, not on the login page.
- What happens if multiple tabs are open? Each tab independently detects and prompts. No cross-tab coordination is required.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST periodically check whether its client-side scripts have changed on the server since the page was loaded.
- **FR-002**: The application MUST present a visible, non-blocking prompt when an update is detected, inviting the user to refresh.
- **FR-003**: The prompt MUST use editorial-style language consistent with the application's tone — warm, understated, and confident.
- **FR-004**: The prompt MUST include a clear action to refresh the page and a way to dismiss it.
- **FR-005**: The prompt MUST visually conform to the existing Stitch design system (dark theme, gold/teal accents, Newsreader/Manrope typography).
- **FR-006**: When the user activates the refresh action, the page MUST fully reload to pick up the updated scripts.
- **FR-007**: When the user dismisses the prompt, it MUST not reappear until the next check cycle confirms the update is still available.
- **FR-008**: If the version check fails (network error, server unreachable, unexpected response), the application MUST silently retry at the next interval without displaying errors.
- **FR-009**: The version check MUST NOT interfere with the application's normal operation, performance, or data display.
- **FR-010**: The version check MUST operate only on the main application page (not on the login page).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users with an open session are notified of an available update within 60 seconds of it becoming available on the server.
- **SC-002**: The update prompt appears and disappears without any visible layout shift or disruption to the dashboard content.
- **SC-003**: After refreshing via the prompt, the user loads the current version of all client-side scripts with no stale cached files.
- **SC-004**: Failed version checks produce zero visible errors or warnings to the user.
- **SC-005**: The prompt's visual design and language pass a subjective review against the Stitch design system guidelines — it feels native to the application.

## Assumptions

- The application already has no service worker or aggressive client-side caching, so a full page reload is sufficient to pick up new scripts.
- The server currently serves static files without explicit cache headers; any caching strategy for the version check endpoint will be decided during planning.
- The polling interval will be a reasonable default (e.g., 30–60 seconds) chosen during implementation to balance responsiveness and server load.
- "Editorial style language" means prose that reads like a magazine or journal — refined, human, slightly literary — rather than technical system messages.
- The check mechanism (e.g., a version manifest, content hash, or ETag comparison) will be determined during the planning phase.
