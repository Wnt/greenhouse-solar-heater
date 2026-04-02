# Contract: RPC Proxy API (Updated)

## POST /api/rpc/{method}

Proxies an RPC call to the Shelly controller. The target device is resolved server-side from `CONTROLLER_IP`.

### Request

**Headers** (required):
- `Content-Type: application/json`
- `X-Requested-With: greenhouse-monitor`

**Body** (JSON):
```json
{
  "id": 1,
  "code": "getStatus()"
}
```

All body fields are forwarded as query parameters to the Shelly device RPC endpoint.

**Removed**: The `_host` field is no longer accepted. The server determines the target device.

### Responses

| Status | Condition | Body |
|--------|-----------|------|
| 200    | Success   | Shelly device JSON response (proxied) |
| 400    | Invalid JSON body | `{ "error": "Invalid JSON body" }` |
| 403    | Missing/wrong `X-Requested-With` header | `{ "error": "Forbidden" }` |
| 405    | Non-POST method (except OPTIONS) | `{ "error": "Method not allowed" }` |
| 502    | Shelly device returned error | `{ "error": "..." }` |
| 503    | Controller IP not configured or device unreachable | `{ "error": "..." }` |

### CORS

- `OPTIONS` returns 204 with CORS headers
- `Access-Control-Allow-Origin`: value of `ORIGIN` env var, or `*` if not set
- `Access-Control-Allow-Methods: POST`
- `Access-Control-Allow-Headers: Content-Type, X-Requested-With`
