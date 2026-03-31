# Data Model: Fix Padding and Status Display Inconsistencies

**Feature**: 015-fix-padding-status-display
**Date**: 2026-03-31

## Connection State Model

This feature introduces a three-state connection awareness model for the Status view in live mode. No persistent data is involved — all state is ephemeral and client-side.

### Entity: Connection State

| Attribute | Type | Description |
|-----------|------|-------------|
| connectionStatus | string | WebSocket connection status: `'connected'`, `'disconnected'`, `'reconnecting'` |
| hasReceivedData | boolean | Whether at least one data update has been received since entering live mode |
| lastDataTime | number (timestamp) | Timestamp of the most recent data update (0 if none) |

### Derived States

| Display State | Condition | Overlay Message |
|---------------|-----------|-----------------|
| never_connected | `!hasReceivedData && connectionStatus !== 'connected'` | *"Your sanctuary is sleeping."* / No connection established |
| disconnected | `hasReceivedData && connectionStatus === 'disconnected'` | *"Lost touch with your sanctuary."* / Connection lost |
| stale | `connectionStatus === 'connected' && lastDataTime > 0 && elapsed > 60s` | *"Your sanctuary has gone quiet."* / No data for 60s |
| active | `connectionStatus === 'connected' && elapsed <= 60s` | No overlay (live data displayed) |

### State Transitions

```
                        ┌──────────────────┐
 switchToLive() ──────▶ │  never_connected  │
                        └────────┬─────────┘
                                 │ WS open + first data
                                 ▼
                        ┌──────────────────┐
                  ┌────▶│     active        │◀───────────┐
                  │     └──┬─────────────┬──┘            │
                  │        │             │               │
                  │  WS close     no data 60s      data arrives
                  │        │             │               │
                  │        ▼             ▼               │
                  │  ┌───────────┐  ┌──────────┐        │
                  │  │disconnected│  │  stale   │────────┘
                  │  └─────┬─────┘  └──────────┘
                  │        │ WS reconnect + data
                  └────────┘

 switchToSimulation() ──▶ all overlays removed, state reset
```

### Device Push State

| Attribute | Type | Description |
|-----------|------|-------------|
| pushEnabled | boolean | Derived: `connectionStatus === 'connected'` |
| pushOverridden | boolean | Transient: set to `true` when user clicks "try anyway" |

No persistent storage needed. All state resets on page reload or mode switch.
