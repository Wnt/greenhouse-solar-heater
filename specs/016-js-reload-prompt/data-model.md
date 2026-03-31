# Data Model: JS Reload Prompt

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## Entities

This feature has minimal data modeling needs — no persistent storage is involved.

### Version Hash (transient, server-computed)

A short string representing the current state of client-side JS files on the server.

| Attribute | Description |
|-----------|-------------|
| hash | SHA-256 hex digest (first 16 characters) of concatenated file stats |
| timestamp | ISO 8601 timestamp of when the hash was computed |

**Lifecycle**: Computed on server startup and recomputed on each `/version` request (with short TTL cache). Not persisted anywhere.

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
