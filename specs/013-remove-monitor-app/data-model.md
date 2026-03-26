# Data Model: Remove Monitor App, Promote Playground

**Feature**: 013-remove-monitor-app
**Date**: 2026-03-26

## Overview

This feature primarily removes code rather than introducing new data models. The data entities below document what is preserved, modified, or removed.

## Entities

### View (new concept — client-side only)

A named section of the single-page app, identified by a URL hash fragment.

| Attribute | Type | Description |
|-----------|------|-------------|
| id | string | View identifier: `status`, `components`, `schematic`, `controls`, `device` |
| fragment | string | URL hash: `#status`, `#components`, `#schematic`, `#controls`, `#device` |
| isLiveOnly | boolean | `true` for `device` view — only shown when connected to live system |

**State transitions**: Views switch on user click, URL hash change, or browser navigation. Default view is `status`.

**Validation**: Unknown fragments map to `status` (default).

### Device Configuration (unchanged)

Runtime settings pushed to Shelly controller via MQTT. Schema unchanged — only the UI descriptions are added.

| Field | Type | Description |
|-------|------|-------------|
| ce | boolean | Controls Enabled — master switch |
| ea | bitmask (int) | Enabled Actuators — bit 1: valves, bit 2: pump, bit 4: fan, bit 8: space heater, bit 16: immersion heater |
| fm | string | Forced Mode — empty (auto), `I`, `SC`, `GH`, `AD`, `EH` |
| am | string[] | Allowed Modes — subset of `["I","SC","GH","AD","EH"]` |

### Preserved Entities (authentication)

The following auth entities are retained to protect the control system:

- **WebAuthn Credential** — passkey credentials stored in S3 (`credentials.json`). Unchanged.
- **Session** — HMAC-signed session cookies (30-day expiry). Unchanged.
- **Invitation** — registration invitation tokens (in-memory, rate-limited). Unchanged.

### Removed Entities

The following data entities are removed with the monitor app:

- **Push Subscription** — web push subscription endpoints stored in S3 (`push-subscriptions.json`)
- **VAPID Keys** — push notification keys stored in S3 (`push-config.json`)

These S3 objects become orphaned and can be manually cleaned up from object storage.
