# Contract: Version Endpoint

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## GET /version

Returns the git commit hash of the deployed application, enabling clients to detect when a new version has been deployed.

### Request

```
GET /version HTTP/1.1
```

No parameters. No authentication required (the commit hash reveals no sensitive information).

### Response

**200 OK**

```json
{
  "hash": "fa37f61abc123def456789abcdef01234567890a"
}
```

| Field | Type | Description |
|-------|------|-------------|
| hash | string | Git commit SHA from the `GIT_COMMIT` environment variable. Defaults to `"unknown"` in local development. |

**Content-Type**: `application/json`

### Behavior

- The hash changes whenever a new Docker image is deployed (each build bakes in `github.sha`).
- The hash is deterministic: the same deployment always returns the same hash.
- Response is lightweight (~60 bytes) and instant (single env var read, no I/O).
- No caching headers are set — the client controls polling frequency.
- In local development, returns `"unknown"` — the version check will not trigger false update prompts since the hash never changes.

### Client Usage Pattern

1. On page load, fetch `GET /version` and store `hash` as the baseline.
2. Every 30 seconds, fetch `GET /version` and compare `hash` to baseline.
3. If hash differs, show the update prompt.
4. On page refresh, the new baseline is captured automatically.
