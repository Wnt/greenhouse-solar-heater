# Feature Specification: Architecture Code Review

**Feature Branch**: `017-architecture-code-review`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: User description: "do an overall architectural code review on the codebase."

## Clarifications

### Session 2026-04-02

- Q: How should the RPC proxy determine the target host? → A: The server MUST look up the target host from its own `CONTROLLER_IP` configuration. The client request MUST NOT supply the target host — this eliminates the SSRF vector entirely.
- Q: When should the server enforce a session secret? → A: Only when `AUTH_ENABLED=true` (cloud/remote mode). Local dev mode (auth off) MUST work without a session secret. This ensures offline LAN development works seamlessly while remote sessions always require authentication.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix Security Vulnerabilities (Priority: P1)

As a system operator, I need the codebase to be free of exploitable security vulnerabilities so that the greenhouse control system cannot be compromised through its web interfaces.

**Why this priority**: The history API currently accepts unsanitized user input in database queries, creating a direct data exposure risk. The RPC proxy allows requests to arbitrary network hosts. These are the most critical issues found in the review.

**Independent Test**: Can be verified by attempting to inject malicious input through the history API query parameters and confirming the system rejects or safely handles it. RPC proxy host validation can be tested by attempting to proxy to disallowed hosts.

**Acceptance Scenarios**:

1. **Given** the history API receives a query with special characters in sensor or entity parameters, **When** the query is executed, **Then** the system uses parameterized queries and no raw input reaches the database engine
2. **Given** the RPC proxy receives a request, **When** the request is processed, **Then** the system uses the server-configured controller IP as the target host and ignores any client-supplied host value
3. **Given** the server starts with authentication enabled but no session secret configured, **When** startup begins, **Then** the server refuses to start and logs a clear error message
4. **Given** the server starts with authentication disabled (local dev mode), **When** startup begins, **Then** the server starts successfully without requiring a session secret

---

### User Story 2 - Eliminate Code Duplication (Priority: P2)

As a developer maintaining this codebase, I need shared patterns extracted into reusable modules so that bug fixes and improvements only need to happen in one place.

**Why this priority**: S3 configuration logic is duplicated across three modules. Valve and actuator identifiers are hardcoded in multiple files. This duplication increases the risk of inconsistent behavior and makes maintenance harder.

**Independent Test**: Can be verified by confirming that S3 client configuration exists in exactly one module, and that valve/actuator names are defined in a single source referenced by all consumers.

**Acceptance Scenarios**:

1. **Given** S3 configuration is needed by any module, **When** the module initializes, **Then** it imports the shared S3 configuration rather than defining its own
2. **Given** a valve or actuator name needs to change, **When** the name is updated in the single source of truth, **Then** all consuming modules (server, Shelly scripts, playground) reflect the change without individual edits

---

### User Story 3 - Standardize Async Error Handling (Priority: P2)

As a developer, I need a consistent asynchronous programming pattern across the server codebase so that error flows are predictable and bugs from mixed patterns are eliminated.

**Why this priority**: The codebase mixes callback-based and promise-based async patterns across modules. This inconsistency makes error handling unpredictable and increases the likelihood of unhandled errors.

**Independent Test**: Can be verified by confirming all server modules use a single async pattern and that error propagation is traceable through the call chain.

**Acceptance Scenarios**:

1. **Given** any server module performs an asynchronous operation, **When** the operation fails, **Then** the error propagates through a consistent mechanism to the caller
2. **Given** a database query fails, **When** the error reaches the request handler, **Then** the handler responds with an appropriate error status without crashing

---

### User Story 4 - Improve Server Routing Architecture (Priority: P3)

As a developer, I need the server's request handling organized into a structured routing layer so that adding or modifying endpoints does not require editing a monolithic handler.

**Why this priority**: The current server.js is a 550+ line monolithic request handler using ad-hoc if/else chains. This makes it difficult to understand the full API surface, add middleware, or maintain route-specific logic.

**Independent Test**: Can be verified by confirming that route handlers are modular, each route is defined in a discoverable location, and adding a new endpoint does not require modifying the main handler function.

**Acceptance Scenarios**:

1. **Given** a new API endpoint needs to be added, **When** a developer implements it, **Then** they create a route handler in the appropriate module without modifying the main server file
2. **Given** authentication middleware needs to be applied to an endpoint, **When** the route is defined, **Then** the middleware is applied declaratively rather than through inline conditionals

---

### User Story 5 - Centralize Configuration Validation (Priority: P3)

As a system operator, I need the server to validate all required configuration at startup so that missing or invalid settings are caught immediately rather than causing silent failures at runtime.

**Why this priority**: Currently, missing environment variables cause features to silently degrade (e.g., database, MQTT, auth). This makes debugging deployment issues difficult and can lead to the system running in an unexpected partial state.

**Independent Test**: Can be verified by starting the server with deliberately missing configuration and confirming it reports all missing required settings at startup.

**Acceptance Scenarios**:

1. **Given** the server starts with required environment variables missing, **When** startup validation runs, **Then** the server logs all missing variables and exits with a clear error
2. **Given** optional features have their configuration missing, **When** startup validation runs, **Then** the server logs which features are disabled and continues operating with remaining capabilities

---

### Edge Cases

- What happens when the S3 storage backend is unreachable during server startup? The system should fall back to local storage gracefully rather than crashing.
- What happens when MQTT payloads contain unexpected or malformed data? The bridge should validate message shape before attempting to decompose and persist.
- What happens when the database connection pool is exhausted? History queries should return a service-unavailable response rather than queuing indefinitely.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All database queries that include user-provided input MUST use parameterized queries instead of string interpolation
- **FR-002**: The RPC proxy MUST resolve the target host from the server's own configuration — client requests MUST NOT supply the target host
- **FR-003**: The server MUST require an explicit session secret when authentication is enabled and refuse to start with a default value; when authentication is disabled (local dev mode), the server MUST start without requiring a session secret
- **FR-004**: S3 client configuration MUST be defined in exactly one shared module and imported by all consumers
- **FR-005**: Valve and actuator identifiers MUST be defined in a single source of truth and referenced by all consuming modules
- **FR-006**: All server-side asynchronous operations MUST follow a single consistent pattern (either callbacks or promises, not a mix)
- **FR-007**: The server MUST validate all required and optional configuration at startup and report status clearly
- **FR-008**: MQTT message payloads MUST be validated against expected shape before being processed or persisted
- **FR-009**: The MQTT bridge MUST receive database access through dependency injection rather than direct module imports
- **FR-010**: The server routing layer MUST be organized so that route handlers are modular and discoverable
- **FR-011**: WebAuthn challenge storage MUST be documented as a known limitation for single-instance deployment, with a clear path to persistent storage if multi-instance is needed

### Key Entities

- **Configuration**: Server environment settings (required vs. optional), device config, S3 credentials — currently scattered across 20+ environment variables with no centralized validation
- **Route**: An API endpoint with its method, path, authentication requirement, and handler — currently implicit in if/else chains
- **Device Identity**: Shelly device IP addresses and script slot assignments — currently hardcoded in control.js

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero database queries use string interpolation for user-provided input — all use parameterized queries
- **SC-002**: The RPC proxy always uses the server-configured controller IP — zero requests use a client-supplied host
- **SC-003**: S3 configuration logic exists in exactly one file, with all other modules importing from it
- **SC-004**: All server modules use a single async pattern — zero mixed callback/promise patterns within any module
- **SC-005**: The server reports all configuration status (missing required, disabled optional) within 5 seconds of startup
- **SC-006**: All existing tests continue to pass after refactoring, with no reduction in test coverage
- **SC-007**: Adding a new API endpoint requires changes to at most 2 files (route definition and handler logic)
- **SC-008**: Malformed MQTT payloads are rejected with a logged warning rather than causing unhandled errors
