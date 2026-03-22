# Feature Specification: Add Home Screen Support

**Feature Branch**: `009-add-home-screen-support`
**Created**: 2026-03-22
**Status**: Draft
**Input**: User description: "Make the app addable into Android / ios home screen"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install App from Android Browser (Priority: P1)

A user opens the Greenhouse Monitor in Chrome on Android. The browser detects the app is installable and shows an install prompt (or the user taps "Add to Home Screen" from the browser menu). After installing, the app appears on their home screen with the Greenhouse Monitor icon and launches in standalone mode (no browser chrome).

**Why this priority**: Android install is the most common PWA install path and requires a valid web app manifest plus a registered service worker with a fetch handler — the foundational requirements that also benefit iOS.

**Independent Test**: Open the monitor URL in Chrome on Android, verify the install prompt appears, install the app, and confirm it launches in standalone mode from the home screen.

**Acceptance Scenarios**:

1. **Given** a user visits the monitor URL in Chrome on Android, **When** the page loads, **Then** the browser recognizes the app as installable (meets PWA install criteria).
2. **Given** a user installs the app to their home screen, **When** they tap the home screen icon, **Then** the app opens in standalone mode without browser UI.
3. **Given** the app is installed, **When** the user opens it while offline, **Then** a meaningful offline fallback page is shown instead of a browser error.

---

### User Story 2 - Install App from iOS Safari (Priority: P1)

A user opens the Greenhouse Monitor in Safari on iPhone or iPad. They tap the Share button and select "Add to Home Screen." The app appears on their home screen with the correct icon and name, and launches in standalone mode.

**Why this priority**: iOS requires specific Apple meta tags beyond the standard web manifest. Without these, the app won't display properly as a standalone app on iOS, showing browser chrome or using a generic icon.

**Independent Test**: Open the monitor URL in Safari on iOS, use Share → "Add to Home Screen", and confirm the icon, name, and standalone launch behavior are correct.

**Acceptance Scenarios**:

1. **Given** a user visits the monitor URL in Safari on iOS, **When** they use Share → "Add to Home Screen", **Then** the correct app name and icon appear in the add dialog.
2. **Given** the app is added to the iOS home screen, **When** the user taps the icon, **Then** the app opens in standalone mode (full screen, no Safari UI).
3. **Given** the app is running in standalone mode on iOS, **When** the user views the status bar, **Then** the status bar style matches the app theme.

---

### User Story 3 - Offline Feedback (Priority: P2)

A user who has installed the app to their home screen opens it when they have no network connection (or the server is unreachable). Instead of seeing a generic browser error page, they see a branded offline page that tells them the app requires a network connection and will work again when connectivity is restored.

**Why this priority**: A proper offline page is required for Android PWA installability (fetch handler in service worker) and provides a much better user experience than a browser error page. However, the app is fundamentally an online tool (reads live sensor data), so full offline functionality is not expected.

**Independent Test**: Install the app, disconnect from the network, open the app, and verify the offline fallback page appears.

**Acceptance Scenarios**:

1. **Given** the app is installed and the user is offline, **When** they open the app, **Then** a branded offline page is displayed with the app name and a clear message.
2. **Given** the user is viewing the offline page, **When** connectivity is restored, **Then** the app automatically navigates to the main page or prompts the user to retry.

---

### Edge Cases

- What happens when the user installs the app but then the manifest or icons change? The app reflects updates on next launch.
- How does the app behave when partially offline (server reachable but Shelly devices unreachable via VPN)? This is existing behavior — the app already shows connection status; the offline page only applies when the server itself is unreachable.
- What happens on browsers that don't support PWA installation (e.g., Firefox on iOS)? The app continues to work as a normal website; no install prompt is shown, which is expected behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The web app manifest MUST include all fields required for PWA installability on Android (name, short_name, start_url, display: standalone, icons with 192px and 512px sizes, theme_color, background_color).
- **FR-002**: The manifest MUST include at least one maskable icon for proper display in adaptive icon contexts on Android.
- **FR-003**: The HTML MUST include Apple-specific meta tags for iOS home screen support: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, and `apple-touch-icon`.
- **FR-004**: The service worker MUST include a fetch handler that serves a branded offline fallback page when the network is unavailable.
- **FR-005**: The offline fallback page MUST display the app name, a clear "you are offline" message, and match the app's visual theme.
- **FR-006**: The login page MUST also include the Apple-specific meta tags and manifest link so that the installed app experience is consistent regardless of entry point.
- **FR-007**: The app MUST register the service worker on page load so that browsers can detect it as installable.

### Key Entities

- **Web App Manifest**: Configuration file declaring app identity, icons, display mode, and theme for the browser's install flow.
- **Service Worker**: Background script that intercepts network requests and serves the offline fallback when the server is unreachable.
- **Offline Fallback Page**: A lightweight HTML page cached by the service worker, shown when no network connection is available.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The app passes Chrome's PWA installability check (Lighthouse "Installable" audit passes).
- **SC-002**: Users can successfully add the app to their home screen on both Android (Chrome) and iOS (Safari) with a correctly displayed icon and name.
- **SC-003**: The installed app launches in standalone mode (no browser chrome) on both platforms.
- **SC-004**: When offline, 100% of installed app launches show the branded offline page instead of a browser error.
- **SC-005**: The existing push notification functionality continues to work without regression after service worker changes.

## Assumptions

- The existing 192px and 512px PNG icons are suitable for home screen use and do not need redesigning. A maskable version can be created from the existing icon by adding padding/safe zone.
- Apple splash screen images (launch screens) are not required for initial implementation — iOS will show a blank screen briefly during launch, which is acceptable.
- The app already has a service worker registered for push notifications; it will be extended (not replaced) to add fetch handling and offline caching.
- Only the monitor app (`monitor/`) needs home screen support — the playground pages do not.
