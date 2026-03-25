# API Contract: RPC Proxy Endpoint

**Version**: 1.0.0
**Base Path**: `/api/rpc/`

## POST /api/rpc/{method}

Proxies an RPC call to a Shelly device.

### Request

**Method**: POST (required — GET returns 405)

**Headers** (required):
| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Type` | `application/json` | Body format |
| `X-Requested-With` | `greenhouse-monitor` | CSRF marker (static value) |
| `Cookie` | session cookie | Auth (when `AUTH_ENABLED=true`) |

**URL Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `method` | string | Shelly RPC method name (e.g., `Script.Eval`, `Temperature.GetStatus`, `Shelly.GetDeviceInfo`) |

**Body** (JSON):
```json
{
  "_host": "192.168.1.174",
  "id": 1,
  "code": "getStatus()"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_host` | string | yes | IP address of target Shelly device |
| *(other)* | any | no | RPC method-specific parameters forwarded to the Shelly device |

### Responses

**200 OK** — Proxied Shelly device response:
```json
{
  "result": "..."
}
```
Headers: `Access-Control-Allow-Origin: {configured origin}`

**400 Bad Request** — Missing `_host` in body:
```json
{ "error": "Missing _host parameter" }
```

**403 Forbidden** — Missing or incorrect `X-Requested-With` header:
```json
{ "error": "Forbidden" }
```

**405 Method Not Allowed** — Request used GET instead of POST:
```
Allow: POST, OPTIONS
```

**502 Bad Gateway** — Shelly device timeout or network error

**503 Service Unavailable** — Shelly device unreachable (connection refused, host unreachable)

## OPTIONS /api/rpc/{method}

CORS preflight response.

### Response

**204 No Content**

Headers:
| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | `{ORIGIN env var}` |
| `Access-Control-Allow-Methods` | `POST` |
| `Access-Control-Allow-Headers` | `Content-Type, X-Requested-With` |
| `Access-Control-Max-Age` | `86400` |

## Migration from Previous API

| Aspect | Before | After |
|--------|--------|-------|
| Method | GET | POST |
| Parameters | Query string (`?_host=...&id=1&code=...`) | JSON body (`{"_host": "...", "id": 1, "code": "..."}`) |
| CORS | `Access-Control-Allow-Origin: *` | `Access-Control-Allow-Origin: {ORIGIN}` |
| Custom header | None | `X-Requested-With: greenhouse-monitor` |
| Preflight | Not handled (404) | Proper OPTIONS response |
