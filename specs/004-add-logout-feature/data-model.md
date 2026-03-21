# Data Model: Add Logout Feature

**Feature**: 004-add-logout-feature
**Date**: 2026-03-21

## Entities

No new entities are introduced by this feature. The logout feature operates on existing data structures:

### Session (existing, unchanged)

- **Token**: Hex string identifying the session
- **Created at**: Timestamp of session creation
- **Expires at**: Timestamp of session expiry (30 days from creation)

The logout action removes a session from the store and clears the browser cookie. No schema changes needed.

### Auth Status Response (existing, unchanged)

- **Authenticated**: Whether the current request has a valid session
- **Setup mode**: Whether no credentials exist yet
- **Registration open**: Whether new passkey registration is allowed

Used by the client to determine logout button visibility. No changes needed.
