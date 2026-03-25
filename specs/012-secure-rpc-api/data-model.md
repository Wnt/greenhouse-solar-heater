# Data Model: Secure RPC API

**Date**: 2026-03-25
**Feature**: 012-secure-rpc-api

## Overview

This feature does not introduce new persistent data entities. It modifies the HTTP request/response format of an existing proxy endpoint.

## Request Format Change

### RPC Proxy Request (before)

```
GET /api/rpc/{method}?_host={ip}&{param}={value}
```

All parameters transmitted as URL query string. No request body.

### RPC Proxy Request (after)

```
POST /api/rpc/{method}
Content-Type: application/json
X-Requested-With: greenhouse-monitor

{"_host": "{ip}", "{param}": "{value}"}
```

Parameters moved to JSON request body. Target device IP included in body as `_host`.

## Server-Side Translation

The proxy translates incoming POST body back to GET query string for the Shelly device:

```
Client POST body → Server extracts _host → Server builds GET URL → Shelly device
{"_host":"x","id":1}    host = "x"           http://x/rpc/Method?id=1
```

No persistent state changes. No database schema changes. No new configuration keys.
