# Quickstart: PWA Push Notifications

**Feature**: 004-pwa-push-notifications
**Date**: 2026-03-21

## Prerequisites

- Node.js 20 LTS
- npm
- A Shelly Pro 4PM controller accessible via network (for valve polling)
- HTTPS in production (push subscriptions require secure context; localhost is exempt for development)

## Setup

1. Install new dependency:

```bash
npm install web-push
```

2. Set environment variables for server-side valve polling:

```bash
# Required for push notifications
export CONTROLLER_IP=192.168.1.174    # Shelly Pro 4PM IP address
export CONTROLLER_SCRIPT_ID=1          # Script slot ID (default: 1)

# Optional: VAPID subject (defaults to mailto:noreply@localhost)
export VAPID_SUBJECT=mailto:you@example.com

# Existing S3 variables (already configured for cloud deployment)
export S3_ENDPOINT=...
export S3_BUCKET=...
export S3_ACCESS_KEY_ID=...
export S3_SECRET_ACCESS_KEY=...
```

3. Start the server:

```bash
node poc/server.js
```

On first startup with S3 configured, the server will:
- Generate VAPID keys and persist to S3 (`push-config.json`)
- Initialize an empty subscriptions list (`push-subscriptions.json`)
- Start polling the controller for valve status every 10 seconds

## Local Development (no push)

Without `CONTROLLER_IP` set, the server runs without valve polling or push — browser-side features (manifest, SW registration, subscribe UI) still work but no notifications will be sent.

```bash
node poc/server.js
# PWA manifest and service worker available
# Subscribe UI shows but notifications won't fire without server polling
```

## Testing

```bash
# Unit tests (includes new push-storage and valve-poller tests)
npm run test:unit

# E2e tests
npm run test:e2e

# All tests
npm test
```

## Cloud Deployment

No infrastructure changes needed. The existing Docker image and S3 bucket are reused. Add these environment variables to the deployer's docker-compose configuration:

```yaml
environment:
  - CONTROLLER_IP=${CONTROLLER_IP}
  - CONTROLLER_SCRIPT_ID=${CONTROLLER_SCRIPT_ID:-1}
  - VAPID_SUBJECT=${VAPID_SUBJECT:-mailto:noreply@localhost}
```

The `web-push` dependency is installed during Docker image build (`npm install` in Dockerfile).

## Verifying the PWA

1. Open Chrome DevTools > Application tab
2. Check "Manifest" section — should show app name, icons, display mode
3. Check "Service Workers" section — should show `sw.js` registered
4. Lighthouse PWA audit should pass installability checks

## Verifying Push Notifications

1. Open the monitor app in a browser
2. Click "Subscribe to notifications"
3. Grant notification permission when prompted
4. Trigger a valve state change (via override buttons or temperature change)
5. Notification should appear within ~10 seconds
