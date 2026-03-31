# Contract: Version Endpoint

**Feature**: 016-js-reload-prompt | **Date**: 2026-03-31

## GET /version

Returns the current content hash of client-side JS files, enabling clients to detect when a new deployment has changed the application code.

### Request

```
GET /version HTTP/1.1
```

No parameters. No authentication required (the hash reveals no sensitive information).

### Response

**200 OK**

```json
{
  "hash": "a1b2c3d4e5f67890",
  "ts": "2026-03-31T12:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| hash | string | Hex digest (16 characters) representing the current state of JS source files |
| ts | string | ISO 8601 timestamp of when the hash was computed |

**Content-Type**: `application/json`

### Behavior

- The hash changes whenever any JS file in the playground's JS directory is modified (content change, replacement, addition, or removal).
- The hash is deterministic: the same set of files with the same contents always produces the same hash.
- Response is lightweight (~70 bytes) and fast (<10ms).
- No caching headers are set — the client controls polling frequency.

### Error Cases

- **500**: Server error computing hash (filesystem issue). Client should treat this as "no update" and retry.

### Client Usage Pattern

1. On page load, fetch `GET /version` and store `hash` as the baseline.
2. Every 30 seconds, fetch `GET /version` and compare `hash` to baseline.
3. If hash differs, show the update prompt.
4. On page refresh, the new baseline is captured automatically.
