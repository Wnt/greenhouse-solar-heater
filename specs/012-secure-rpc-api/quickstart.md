# Quickstart: Secure RPC API

**Feature**: 012-secure-rpc-api

## Files to Modify

1. **`monitor/server.js`** — Server-side changes:
   - Add JSON body parsing for POST `/api/rpc/` requests
   - Add `X-Requested-With` header validation middleware
   - Add CORS preflight (OPTIONS) handler for `/api/rpc/`
   - Change `proxyRpc` to read params from parsed body instead of query string
   - Reject GET requests to `/api/rpc/` with 405
   - Replace `Access-Control-Allow-Origin: *` with `ORIGIN` env var value

2. **`monitor/js/shelly-api.js`** — Client-side changes:
   - Change `rpcTo()` from GET with query params to POST with JSON body
   - Add `X-Requested-With: greenhouse-monitor` header to all fetch calls
   - Add `Content-Type: application/json` header

3. **`tests/rpc-proxy.test.js`** (new) — Unit tests:
   - Marker header validation (present/absent/wrong value)
   - Method enforcement (POST accepted, GET rejected with 405)
   - CORS preflight responses (OPTIONS)
   - Body parsing and `_host` extraction
   - Integration with existing auth gate

## Development Flow

```bash
# Run existing tests to verify baseline
npm run test:unit

# Make server-side changes (server.js)
# Make client-side changes (shelly-api.js)
# Add new tests (rpc-proxy.test.js)

# Run all tests
npm test

# Manual test with curl
# Should be rejected (no marker header):
curl -X POST http://localhost:3000/api/rpc/Shelly.GetDeviceInfo \
  -H 'Content-Type: application/json' \
  -d '{"_host":"192.168.1.174"}'

# Should succeed (with marker header):
curl -X POST http://localhost:3000/api/rpc/Shelly.GetDeviceInfo \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: greenhouse-monitor' \
  -d '{"_host":"192.168.1.174"}'

# Should be rejected (GET method):
curl http://localhost:3000/api/rpc/Shelly.GetDeviceInfo?_host=192.168.1.174
```

## Key Design Points

- `X-Requested-With: greenhouse-monitor` is a CSRF mitigation, not a secret
- The server translates POST body → GET query string when forwarding to Shelly devices
- Valve poller (`monitor/lib/valve-poller.js`) is unaffected — it calls Shelly directly
- CORS origin comes from existing `ORIGIN` env var (already in `config.env`)
