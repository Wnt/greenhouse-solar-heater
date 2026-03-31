# Data Model: JS Reload Prompt

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## Entities

This feature has minimal data modeling needs — no persistent storage is involved.

### Version Hash (server environment)

The git commit SHA identifying the deployed version.

| Attribute | Description |
|-----------|-------------|
| hash | `GIT_COMMIT` environment variable (full SHA, or `"unknown"` in local dev) |

**Lifecycle**: Baked into the Docker image at build time. Constant for the lifetime of the container. Changes only on redeployment.

### Client Version State (in-memory, browser)

State held in the browser module during a page session.

| Attribute | Description |
|-----------|-------------|
| initialHash | Hash captured on first successful `/version` fetch after page load |
| isUpdateAvailable | Boolean — true when server hash differs from initialHash |
| isDismissed | Boolean — true when user has dismissed the current prompt |
| pollIntervalId | Reference to the setInterval timer for cleanup |

**Lifecycle**: Created when the version-check module initializes. Destroyed on page unload or refresh.

## State Transitions

```
[Idle] --poll returns same hash--> [Idle]
[Idle] --poll returns different hash--> [Update Available]
[Update Available] --user clicks refresh--> [Page Reload]
[Update Available] --user dismisses--> [Dismissed]
[Dismissed] --next poll confirms update--> [Update Available]
[Dismissed] --poll returns same hash as initial--> [Idle] (rollback scenario)
```
