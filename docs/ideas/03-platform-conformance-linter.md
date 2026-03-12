# Idea 3 — Platform Conformance Linter

Static analysis tool that verifies Shelly control scripts conform to the Shelly scripting platform's resource limits and API constraints before deployment.

## Problem

Shelly Gen2+ scripting (Espruino-based) has hard resource limits that aren't caught by standard JavaScript linters:

- Max 5 timers per script
- Max 5 event subscriptions per script
- Max 5 concurrent RPC/HTTP calls
- No Promises, async/await, or ES6 classes
- No `require()` / module imports
- Limited heap (~30KB usable)
- Single script execution context (no Web Workers)

Violating these limits causes silent failures or crashes on the device. The feedback loop is slow — flash script, observe failure, guess the cause. A linter catches these issues at authoring time.

## Scope

A CLI tool (and optionally a CI check) that analyzes Shelly script files and reports violations of platform constraints.

## Functional Requirements

### Rules

| Rule ID | Category | Check | Severity |
|---------|----------|-------|----------|
| `SH-001` | Resource limit | Count `Timer.set()` calls — warn if >5 per script | Error |
| `SH-002` | Resource limit | Count `Shelly.addStatusHandler()` + `Shelly.addEventHandler()` — warn if >5 | Error |
| `SH-003` | Resource limit | Count concurrent `Shelly.call()` / `HTTP.GET` — warn if >5 reachable from any code path | Warning |
| `SH-004` | Syntax | Flag `async`, `await`, `class`, `import`, `export`, `require` keywords | Error |
| `SH-005` | Syntax | Flag Promise constructors (`new Promise`), `.then()`, `.catch()` | Error |
| `SH-006` | Syntax | Flag arrow functions with implicit return (Espruino compatibility varies) | Warning |
| `SH-007` | Syntax | Flag template literals (backtick strings) — not supported in older firmware | Warning |
| `SH-008` | Syntax | Flag destructuring assignments | Warning |
| `SH-009` | Syntax | Flag spread/rest operators (`...`) | Warning |
| `SH-010` | Safety | Verify pump stop before valve switch in mode transition sequences | Error |
| `SH-011` | Safety | Verify exactly one input valve + one output valve open per mode | Error |
| `SH-012` | Size | Estimate script size — warn if >16KB (practical deployment limit) | Warning |
| `SH-013` | API | Flag calls to APIs not available on Shelly Gen2+ (e.g. `fetch`, `XMLHttpRequest`) | Error |

### Safety Rules (System-Specific)

Rules SH-010 and SH-011 are specific to this project — they validate control logic against `system.yaml`:

- **SH-010**: In any mode transition function, the pump relay must be set to OFF before any valve relay state changes. Parse the function body for relay call ordering.
- **SH-011**: For each mode's valve states (from `system.yaml`), verify the script sets exactly one `vi_*` and one `vo_*` valve to OPEN.

### Output Formats

- **Terminal**: colored output with file:line references (default)
- **JSON**: machine-readable for CI integration
- **GitHub Actions annotations**: `::error file=...` format for inline PR comments

## Technical Approach

### Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | Node.js (JavaScript) | Same language as Shelly scripts; AST tools readily available |
| Parser | `acorn` or `espree` | Lightweight JS parser, produces ESTree AST |
| AST traversal | `acorn-walk` or custom walker | Visit nodes to count API calls, flag syntax |
| YAML parsing | `js-yaml` | Load `system.yaml` for safety rule validation |
| CLI framework | Bare `process.argv` or `commander` | Minimal dependencies |

### Architecture

```
shelly-lint <script.js> [--config system.yaml] [--format terminal|json|github]

┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Parse   │────▶│  AST     │────▶│  Rules   │────▶│  Report  │
│  (acorn) │     │  Walker  │     │  Engine  │     │  Format  │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                       ▲
                                       │
                                  ┌────┴─────┐
                                  │ system   │
                                  │ .yaml    │
                                  │ (safety  │
                                  │  rules)  │
                                  └──────────┘
```

### Rule Implementation Pattern

Each rule is a module exporting:

```javascript
module.exports = {
  id: "SH-001",
  description: "Max 5 timers per script",
  severity: "error",
  check(ast, context) {
    // Walk AST, return array of {line, column, message}
  }
};
```

### CI Integration

```yaml
# .github/workflows/lint-shelly.yml
- name: Lint Shelly scripts
  run: npx shelly-lint scripts/*.js --config system.yaml --format github
```

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Concurrent call counting requires control flow analysis | False positives/negatives on SH-003 | Start with simple call counting; add callback-chain analysis later |
| Shelly firmware updates change supported syntax | Linter rules become stale | Pin rules to firmware version; document which firmware each rule targets |
| Safety rules (SH-010/011) are fragile to code structure changes | Rules break when script is refactored | Use semantic checks (find relay calls in same function scope) not string matching |

## Implementation Phases

### Phase 1 — Syntax Rules (SH-004 through SH-009, SH-013)

Easiest to implement — pure AST node type checks. No `system.yaml` needed.

Deliverable: `shelly-lint script.js` catches unsupported syntax.

### Phase 2 — Resource Limits (SH-001 through SH-003, SH-012)

Count specific API calls in the AST. SH-003 (concurrent calls) starts with a simple count and can be refined later.

Deliverable: resource limit warnings before deployment.

### Phase 3 — Safety Rules (SH-010, SH-011)

Requires parsing `system.yaml` and cross-referencing with script logic. More complex — needs to understand relay-to-valve mapping and mode transition sequences.

Deliverable: automated safety verification against the spec.

## Success Criteria

- Catches all unsupported ES6+ syntax before deployment (zero false negatives on SH-004/005)
- Correctly counts timer and event handler registrations (validated against known scripts)
- Safety rules flag a deliberate "pump still running during valve switch" test case
- Runs in <2s for a typical Shelly script (~500 lines)
- Integrates into GitHub Actions CI pipeline with inline annotations
