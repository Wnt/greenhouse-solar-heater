# Contract: Storage Adapter (Credentials Persistence)

**Feature**: 002-containerize-upcloud-deploy
**Date**: 2026-03-21

## Purpose

Abstraction layer between the app's credential read/write operations and the storage backend. Currently the app uses `fs.readFile/writeFile` directly. This contract defines the interface for an S3-backed storage adapter.

## Interface

### Read Credentials

- **Input**: None (bucket and key configured via environment)
- **Output**: Parsed JSON object (credentials data), or `null` if no credentials exist yet
- **Errors**: Throws on network/permission failures; returns `null` on "not found"

### Write Credentials

- **Input**: JavaScript object (credentials data)
- **Output**: Success/failure
- **Behavior**: Serializes to JSON, writes to S3 bucket. Atomic from the app's perspective.
- **Errors**: Throws on network/permission failures

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `S3_ENDPOINT` | Yes | Object Storage endpoint URL |
| `S3_BUCKET` | Yes | Bucket name for credentials |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret access key |
| `S3_REGION` | No | Region (default: `europe-1`) |
| `CREDENTIALS_KEY` | No | Object key (default: `credentials.json`) |

## Backward Compatibility

When `CREDENTIALS_PATH` is set (local file path) and `S3_ENDPOINT` is not set, the adapter falls back to local filesystem operations. This preserves local development mode (`node poc/server.js` without S3).
