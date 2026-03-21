# Feature Specification: PWA Push Notifications for Valve Changes

**Feature Branch**: `004-pwa-push-notifications`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "add a PWA manifest to the Shelly monitor PoC and make the server push a push notification to the client when valves change position. All persistence should reside in object storage."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install Monitor as App (Priority: P1)

A user visits the Shelly monitor PoC in their mobile or desktop browser and is prompted to install it as a standalone app. After installation, the monitor appears on their home screen with a branded icon and launches without the browser address bar.

**Why this priority**: PWA installability is the foundation — without the manifest and service worker, push notifications cannot be delivered. This story is a prerequisite for all others.

**Independent Test**: Can be fully tested by visiting the PoC URL in Chrome/Edge, verifying the install prompt appears, installing the app, and confirming it launches in standalone mode with the correct name and icon.

**Acceptance Scenarios**:

1. **Given** a user visits the PoC URL in a supported browser, **When** the page loads, **Then** the browser recognizes the app as installable (manifest is valid, service worker is registered).
2. **Given** a user has installed the PWA, **When** they launch it from their home screen, **Then** it opens in standalone mode without the browser address bar, with the correct app name and theme colors.

---

### User Story 2 - Subscribe to Valve Change Notifications (Priority: P1)

A user who has installed or is using the monitor wants to receive push notifications when valves change position. They tap a "Subscribe to notifications" button, grant the browser permission, and see confirmation that they are subscribed.

**Why this priority**: This is the core user interaction that enables the push notification feature. Without subscription, no notifications can be sent.

**Independent Test**: Can be tested by clicking the subscribe button, granting notification permission, and verifying the subscription is stored on the server.

**Acceptance Scenarios**:

1. **Given** a user is on the monitor page, **When** they tap the subscribe button and grant notification permission, **Then** a push subscription is created and stored on the server, and the UI confirms the subscription.
2. **Given** a user has already subscribed, **When** they visit the monitor page, **Then** the UI shows they are already subscribed and offers an option to unsubscribe.
3. **Given** a user denies notification permission, **When** the subscription attempt fails, **Then** the UI displays a clear message explaining that permission was denied and how to re-enable it.

---

### User Story 3 - Receive Valve Change Notification (Priority: P1)

A subscribed user receives a push notification on their device whenever a valve changes position (opens or closes). The notification includes which valve changed and its new state.

**Why this priority**: This is the primary value of the feature — timely awareness of valve state changes without needing to keep the app open.

**Independent Test**: Can be tested by subscribing, then triggering a valve state change on the Shelly controller, and verifying a notification appears on the device within the polling cycle.

**Acceptance Scenarios**:

1. **Given** a subscribed user with the app closed, **When** valve V1 changes from closed to open, **Then** they receive a push notification stating "V1 opened" with relevant context (e.g., auto mode, override).
2. **Given** a subscribed user, **When** valve V2 changes from open to closed, **Then** they receive a push notification stating "V2 closed".
3. **Given** a subscribed user, **When** they tap the notification, **Then** the monitor app opens (or focuses if already open).

---

### User Story 4 - Unsubscribe from Notifications (Priority: P2)

A user who no longer wants notifications can unsubscribe. Their subscription is removed from the server and they stop receiving push notifications.

**Why this priority**: Users must be able to opt out. Lower priority because it's a secondary flow.

**Independent Test**: Can be tested by unsubscribing via the UI button and verifying no further notifications arrive after a valve change.

**Acceptance Scenarios**:

1. **Given** a subscribed user, **When** they tap the unsubscribe button, **Then** the subscription is removed from the server and the UI reverts to the subscribe state.
2. **Given** an unsubscribed user, **When** a valve changes position, **Then** no notification is sent to that user.

---

### Edge Cases

- What happens when the server cannot reach the Shelly controller (VPN down, device offline)? No valve state changes are detected, so no notifications are sent. The system must not send spurious notifications when connectivity is restored.
- What happens when a push subscription expires or becomes invalid? The server must remove stale subscriptions that return errors from the push service.
- What happens when multiple valves change simultaneously (e.g., mode switch)? Each valve change should generate its own notification, or a single grouped notification summarizing all changes.
- What happens when the server restarts? It must resume polling and detect the first state difference compared to the last known state. It must not send notifications for the initial state read after startup (no "previous" state to compare against).
- What happens when a user subscribes from multiple devices? Each device gets its own subscription and receives independent notifications.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The monitor app MUST include a valid PWA manifest with app name, icons, theme color, and standalone display mode.
- **FR-002**: The monitor app MUST register a service worker that handles push events and displays notifications.
- **FR-003**: The server MUST poll the Shelly controller for valve status at a regular interval and detect state changes (valve open/close transitions).
- **FR-004**: Users MUST be able to subscribe to push notifications via a UI control in the monitor.
- **FR-005**: Users MUST be able to unsubscribe from push notifications via the same UI control.
- **FR-006**: The server MUST send a push notification to all active subscribers when a valve changes position.
- **FR-007**: Push notification content MUST identify which valve changed and its new state (open or closed).
- **FR-008**: Push subscriptions MUST be persisted in object storage so they survive server restarts.
- **FR-009**: VAPID keys for the push service MUST be persisted in object storage so they remain stable across server restarts and redeployments.
- **FR-010**: The server MUST remove subscriptions that are rejected by the push service (expired or unsubscribed endpoints).
- **FR-011**: Tapping a push notification MUST open or focus the monitor app.
- **FR-012**: The server MUST NOT send notifications for the initial state read after startup (no previous state to compare).
- **FR-013**: The service worker MUST be scoped to the monitor app and not interfere with other static assets or routes.

### Key Entities

- **Push Subscription**: A browser-generated subscription object (endpoint URL, encryption keys) representing a single device's ability to receive push messages. Multiple subscriptions may exist per user (one per device/browser).
- **VAPID Key Pair**: A public/private key pair used to authenticate the server with push services. Shared across all subscriptions. Must remain stable to avoid invalidating existing subscriptions.
- **Valve State**: The current open/closed status of each valve (V1, V2) as reported by the Shelly controller. Changes in state trigger notifications.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The monitor app passes browser PWA installability checks (Lighthouse PWA audit or equivalent).
- **SC-002**: A subscribed user receives a push notification within one polling cycle (currently ~10 seconds) of a valve state change.
- **SC-003**: Notifications are delivered even when the monitor app is closed or the browser is in the background.
- **SC-004**: Push subscriptions and VAPID keys persist across server restarts — no re-subscription required after a redeployment.
- **SC-005**: Stale or invalid subscriptions are automatically cleaned up without manual intervention.

## Assumptions

- The existing 10-second server-side polling interval for Shelly device status is acceptable for notification timeliness. Notifications do not need sub-second delivery.
- The server already has access to the Shelly controller via the RPC proxy mechanism; server-side valve polling will use the same approach.
- VAPID-based Web Push is the standard mechanism; no proprietary push services (FCM, APNs) are needed beyond what Web Push already uses.
- The monitor is a single-user system (one greenhouse owner), but multiple device subscriptions are supported for that user.
- The existing S3 storage adapter pattern (used for WebAuthn credentials) will be extended for push subscription and VAPID key persistence.
- Icons for the PWA manifest will be simple generated icons or placeholder icons; no custom graphic design is required.
- The service worker will handle push events only — offline caching of the app shell is out of scope for this feature.
