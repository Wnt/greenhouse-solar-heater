# Research: Secure RPC API

**Date**: 2026-03-25
**Feature**: 012-secure-rpc-api

## R1: Custom Header Choice for CSRF Mitigation

**Decision**: Use `X-Requested-With: greenhouse-monitor` as the marker header.

**Rationale**: `X-Requested-With` is a well-established convention (used by jQuery, Angular, Rails) for CSRF mitigation. Browsers never attach this header to navigation requests, form submissions, or resource loads (img, script, link tags). Any request carrying a custom header triggers a CORS preflight, which the server can reject for unauthorized origins. The static value `greenhouse-monitor` makes intent explicit without needing to be secret.

**Alternatives considered**:
- `X-CSRF-Token` with a random value — requires server-side token generation and session-bound storage, adding complexity for no additional benefit since the app already uses session cookies for auth.
- Custom `Authorization` scheme — overloads a standard header, conflicts with potential future auth mechanisms.
- No custom header, rely on CORS alone — insufficient because CORS is browser-enforced only; non-browser clients (scripts, curl) would still have access.

## R2: HTTP Method for RPC Proxy

**Decision**: Use POST for all RPC proxy calls.

**Rationale**: POST is the natural choice for operations that have side effects (valve control, script evaluation). It prevents URL-based parameter leakage and cannot be triggered by simple navigation or image/link tags. The Shelly devices themselves only accept GET, so the server-side proxy translates POST body → GET query string when forwarding.

**Alternatives considered**:
- PUT — semantically for resource replacement, not a good fit for RPC calls.
- PATCH — semantically for partial updates, also not a good fit.
- Custom method — poor tooling support, unnecessary complexity.

## R3: CORS Origin Handling in Local vs Cloud Mode

**Decision**: Use the `ORIGIN` env var (already set for WebAuthn in cloud mode) for CORS `Access-Control-Allow-Origin`. In local mode (no `ORIGIN` set), allow same-origin requests only (omit the header, letting browser default to same-origin policy).

**Rationale**: The `ORIGIN` env var is already configured in the deployment (`config.env`) and used by WebAuthn. Reusing it avoids adding another configuration surface. In local mode, the app runs on a trusted LAN where same-origin is sufficient.

**Alternatives considered**:
- Separate `CORS_ORIGIN` env var — unnecessary config duplication since `ORIGIN` already exists.
- Always use `*` in local mode — overly permissive for no benefit.

## R4: Request Body Format

**Decision**: Use JSON request body (`Content-Type: application/json`) with `_host`, `method` (in URL path), and RPC params as top-level keys.

**Rationale**: The existing `readBody` + `JSON.parse` pattern is already used by PUT `/api/device-config`. JSON bodies are well-supported by `fetch()` and naturally accommodate nested parameters. The RPC method stays in the URL path (`/api/rpc/{method}`) for clarity and routing.

**Alternatives considered**:
- URL-encoded form body — less flexible, harder to handle nested params.
- Entirely body-based routing (method in body too) — loses RESTful URL semantics, harder to log/debug.

## R5: Auth Gate Interaction

**Decision**: The `/api/rpc/` route is already behind the auth gate (when `AUTH_ENABLED=true`). The marker header adds defense-in-depth but does not replace session authentication.

**Rationale**: The auth gate at lines 403-414 of `server.js` runs before the `/api/rpc/` route check at line 431. Both protections (session auth + marker header) apply independently. This gives two layers: session auth verifies the user, marker header prevents CSRF even for authenticated users.

## R6: Existing Test Coverage

**Decision**: Add new unit tests for the server-side middleware (marker header validation, CORS preflight, method enforcement) and update e2e tests to verify the client-side changes work end-to-end.

**Rationale**: No existing tests cover the RPC proxy (`proxyRpc` function). The valve-poller has thorough unit tests. The new security middleware is pure request validation logic that can be tested in isolation.
