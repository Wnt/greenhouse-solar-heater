# Feature Specification: Secure RPC API

**Feature Branch**: `012-secure-rpc-api`
**Created**: 2026-03-25
**Status**: Draft
**Input**: User description: "Currently the monitor app uses hugely insecure GET requests to do RPC calls on the shelly. Add security mechanisms such as CORS. All API requests should be done via the client-side and rely on a special marker header (with static value) to be present. Also change the method to something else than GET."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prevent Cross-Site Request Forgery on RPC Endpoints (Priority: P1)

An attacker could craft a malicious page that triggers Shelly RPC calls (e.g., `Script.Eval` with arbitrary code) by embedding GET requests as image sources or links. The system must reject any RPC request that does not originate from the monitor application itself.

**Why this priority**: This is the core security vulnerability — GET-based RPC with no origin validation allows trivial CSRF attacks that could control physical greenhouse hardware (valves, pumps).

**Independent Test**: Can be tested by making RPC requests from different origins and verifying they are rejected, while requests from the monitor UI succeed.

**Acceptance Scenarios**:

1. **Given** the monitor app is running, **When** a request to `/api/rpc/Script.Eval` arrives without the required marker header, **Then** the server responds with a 403 Forbidden status.
2. **Given** the monitor app is running, **When** a request to `/api/rpc/Script.Eval` arrives with the correct marker header and from an allowed origin, **Then** the request is proxied to the Shelly device normally.
3. **Given** a malicious website tries to send a request to the RPC endpoint, **When** the browser performs a CORS preflight check, **Then** the preflight response does not include the malicious origin in `Access-Control-Allow-Origin`, and the browser blocks the request.

---

### User Story 2 - Switch RPC Proxy to POST Method (Priority: P1)

All RPC proxy calls currently use GET, which means parameters (including executable code in `Script.Eval`) appear in URLs, query strings, server logs, and browser history. The system must use a non-GET method so that RPC parameters are sent in the request body instead.

**Why this priority**: GET requests with sensitive parameters are logged everywhere (proxy logs, browser history, server access logs) and can be triggered by simple link navigation or image tags.

**Independent Test**: Can be tested by sending GET requests to the RPC endpoint and verifying they are rejected, while POST requests with body parameters succeed.

**Acceptance Scenarios**:

1. **Given** the RPC proxy endpoint exists, **When** a client sends a POST request with parameters in the request body, **Then** the server proxies the call to the Shelly device and returns the response.
2. **Given** the RPC proxy endpoint exists, **When** a client sends a GET request, **Then** the server responds with 405 Method Not Allowed.
3. **Given** the monitor UI is loaded, **When** the user interacts with any feature that triggers RPC calls (temperature polling, valve control), **Then** all calls use POST with a JSON request body.

---

### User Story 3 - Restrict CORS to Application Origin (Priority: P2)

The current `Access-Control-Allow-Origin: *` header allows any website to make requests to the RPC endpoint. The system must restrict CORS to only allow the monitor application's own origin.

**Why this priority**: Tightening CORS prevents browser-based cross-origin attacks, complementing the marker header check.

**Independent Test**: Can be tested by making cross-origin requests from a different origin and verifying the browser blocks them due to CORS policy.

**Acceptance Scenarios**:

1. **Given** the server is running, **When** a CORS preflight (OPTIONS) request arrives for `/api/rpc/`, **Then** the response includes `Access-Control-Allow-Origin` set to the application's own origin (not `*`), and includes `Access-Control-Allow-Headers` listing the marker header name.
2. **Given** the server receives a same-origin request with the marker header, **When** the response is sent, **Then** the `Access-Control-Allow-Origin` header reflects the request origin.

---

### Edge Cases

- What happens when the marker header has an incorrect value? The server rejects the request with 403.
- What happens when a non-browser client (e.g., curl) sends requests without CORS? The marker header check still applies — requests without the header are rejected regardless of client type.
- What happens to the server-side valve poller that calls Shelly devices directly (not through the proxy)? It is unaffected — it makes direct HTTP calls to Shelly devices on the LAN/VPN, not through the proxy endpoint.
- What happens to existing non-RPC API routes (`/api/device-config`, `/api/history`, `/api/push/`)? They are outside the scope of this change — only `/api/rpc/` is affected.
- What happens in local mode (no `ORIGIN` env var)? CORS uses same-origin behavior; the marker header is still required.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The RPC proxy endpoint MUST only accept POST requests. GET requests MUST receive a 405 Method Not Allowed response.
- **FR-002**: The RPC proxy endpoint MUST require a specific custom header with a predefined static value on every request. Requests missing the header or with an incorrect value MUST receive a 403 Forbidden response.
- **FR-003**: The server MUST respond to CORS preflight (OPTIONS) requests for `/api/rpc/` with restrictive headers: `Access-Control-Allow-Origin` set to the application's configured origin (not `*`), and `Access-Control-Allow-Headers` including the custom marker header name.
- **FR-004**: The client-side RPC module MUST send all RPC calls as POST requests with parameters in a JSON request body instead of query string parameters.
- **FR-005**: The client-side RPC module MUST include the custom marker header with the correct static value on every RPC request.
- **FR-006**: The server-side valve poller (which calls Shelly devices directly, not through the proxy) MUST continue to function without changes.
- **FR-007**: The target device identifier (currently the `_host` query parameter) MUST be included in the POST request body alongside other RPC parameters.
- **FR-008**: When running in cloud mode with authentication enabled, the existing session-based auth gate MUST apply to RPC endpoints in addition to the new marker header check.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All RPC proxy calls from the monitor UI complete successfully using the new secured method, with no degradation in user-visible response time.
- **SC-002**: 100% of RPC proxy requests lacking the marker header are rejected with 403, regardless of client type.
- **SC-003**: Cross-origin requests to the RPC proxy from unauthorized origins are blocked by the browser's CORS enforcement.
- **SC-004**: Existing user-facing functionality (temperature polling, valve control, valve status display) works identically after the change.
- **SC-005**: Server-side valve polling and push notifications continue to function without interruption.

## Assumptions

- The marker header name and static value are hardcoded (not configurable) since they serve as CSRF mitigation, not a secret. The value's purpose is to prove the request was made programmatically by the app (browsers don't add custom headers to navigation or form submissions).
- The application's origin for CORS is derived from the existing `ORIGIN` environment variable (already used for WebAuthn). In local mode without `ORIGIN` set, CORS can be permissive since the app runs on a trusted LAN.
- The Shelly devices themselves still accept GET requests — only the proxy endpoint changes. The server translates the incoming POST into the appropriate request to the Shelly device.
