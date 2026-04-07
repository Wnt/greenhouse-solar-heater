# Data Model: Manual Relay Toggle UI

**Feature**: 022-relay-toggle-ui  
**Date**: 2026-04-07

## Entities

### Device Config (extended)

Existing entity with new field. Compact JSON for Shelly KVS (256-byte limit).

| Field | Type | Description |
|-------|------|-------------|
| `ce` | boolean | Controls enabled (existing) |
| `ea` | integer | Enabled actuators bitmask (existing) |
| `fm` | string\|null | Forced mode (existing) |
| `am` | array\|null | Allowed modes (existing) |
| `v` | integer | Version, auto-incremented on update (existing) |
| `mo` | object\|null | **NEW**: Manual override session. Null when inactive. |

### Manual Override Session (`mo`)

Nested within device config. Transient — set to null when override ends.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `a` | boolean | false | Active flag |
| `ex` | integer | — | Expiry timestamp (unix seconds) |
| `ss` | boolean | false | Suppress safety overrides |

**Lifecycle**:
- **Created**: When user enters manual override. Server sets `ex = now + ttl` and publishes config.
- **Active**: `mo.a === true && now < mo.ex`. Control loop skips `evaluate()`.
- **Expired**: Device detects `now >= mo.ex` on next control loop iteration (≤30s latency). Device clears `mo` from config, saves to KVS, and emits state update. Server also tracks expiry as secondary measure.
- **Cancelled**: User exits override. Server publishes config with `mo: null`.
- **Interrupted**: External `ce=false` change. Server publishes config with `mo: null`.

**Validation rules**:
- `mo.ex` must be in the future when created
- `mo.ss` defaults to `false` (safe default)
- `fm` (forced mode) is ignored while `mo.a === true` — manual override takes precedence
- When `mo` transitions from active to null, `fm` resumes effect if set

### Relay Command

Transient message, not persisted. Transmitted via MQTT.

| Field | Type | Description |
|-------|------|-------------|
| `relay` | string | Actuator identifier: `vi_btm`, `vi_top`, `vi_coll`, `vo_coll`, `vo_rad`, `vo_tank`, `v_ret`, `v_air`, `pump`, `fan` |
| `on` | boolean | Desired state: true=on/open, false=off/closed |

**Validation rules**:
- `relay` must be one of the 10 recognized identifiers
- Command is rejected if manual override is not active
- Command is rejected if controls are not enabled (`ce=false`)
- For `v_air`: physical logic inversion handled on device side (existing behavior)

### WebSocket Command Messages

Client→Server messages over the existing WebSocket connection.

#### Enter Override
```json
{"type": "override-enter", "ttl": 300, "suppressSafety": false}
```
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | — | `"override-enter"` |
| `ttl` | integer | 300 | TTL in seconds (60–3600) |
| `suppressSafety` | boolean | false | Suppress safety overrides |

#### Exit Override
```json
{"type": "override-exit"}
```

#### Relay Toggle
```json
{"type": "relay-command", "relay": "pump", "on": true}
```
| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"relay-command"` |
| `relay` | string | Actuator identifier |
| `on` | boolean | Desired state |

### Server→Client State Updates (existing, extended)

The existing state broadcast gains override awareness:

| Field | Type | Description |
|-------|------|-------------|
| `manual_override` | object\|null | **NEW**: `{active: true, expiresAt: number, suppressSafety: boolean}` or null |

This allows the UI to display override status and countdown without additional polling.

## State Transitions

```
AUTOMATION ──[enter override]──→ MANUAL_OVERRIDE
    ↑                                    │
    │                                    ├──[TTL expires]──→ AUTOMATION
    │                                    ├──[user exits]──→ AUTOMATION
    │                                    ├──[ce=false]──→ AUTOMATION (controls disabled)
    │                                    └──[safety trigger, ss=false]──→ SAFETY_MODE
    │                                                                        │
    └────────────────────────────────────────────────────────────────────────┘
                                   (override cancelled, automation resumes)
```

When `ss=true` (safety suppressed), safety triggers are ignored for the duration of the override.
