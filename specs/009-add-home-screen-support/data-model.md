# Data Model: Add Home Screen Support

**Date**: 2026-03-22
**Feature**: 009-add-home-screen-support

## Overview

This feature does not introduce new persistent data entities. It modifies configuration files (manifest, HTML meta tags) and extends the service worker with a fetch handler and cached offline page.

## Entities

### Web App Manifest (manifest.json)

Configuration file — not a data entity. Extended with:

| Field | Current | Change |
|-------|---------|--------|
| `name` | "Greenhouse Monitor" | No change |
| `short_name` | "Monitor" | No change |
| `start_url` | "/" | No change |
| `display` | "standalone" | No change |
| `theme_color` | "#0056b2" | No change |
| `background_color` | "#f5f7f8" | No change |
| `icons[0]` | 192px, type png | Add `"purpose": "any"` |
| `icons[1]` | 512px, type png | Add `"purpose": "any maskable"` |
| `id` | — | Add `"/"` (stable app identity) |

### Service Worker Cache

Runtime cache managed by the service worker. Not persistent across SW updates (recached on install).

| Cached Resource | Purpose |
|----------------|---------|
| `/offline.html` | Offline fallback page |
| `/icons/icon-192.png` | Offline page branding |

### Offline Fallback Page (offline.html)

Static HTML page — not a data entity. New file with:

| Attribute | Value |
|-----------|-------|
| App name display | "Greenhouse Monitor" |
| Status message | "You are offline" |
| Auto-retry | Periodic connectivity check, reload when online |
| Styling | Matches monitor app theme |
