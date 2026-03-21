# Research: VPN Key Persistence

**Feature**: 004-vpn-key-persistence
**Date**: 2026-03-21

## R1: How can the deployer access S3?

**Context**: The deployer container is based on `docker:cli` (minimal Alpine). It has no Node.js, no AWS SDK, no curl. The app image has Node.js 20 + `@aws-sdk/client-s3`. The deployer already has Docker socket access (`-v /var/run/docker.sock:/var/run/docker.sock`).

**Decision**: Use the app image as a one-shot S3 helper via `docker run --rm`.

The deployer already pulls the app image during deployment (`docker compose pull`). After pulling, it can run the app image with a helper script to download/upload VPN config from/to S3. This happens before `docker compose up -d`, so the config is in place when the WireGuard container starts.

**Rationale**:
- Zero new dependencies in the deployer image
- Reuses the existing S3 storage adapter (`poc/lib/s3-storage.js`) and its env vars
- Follows the existing pattern: deployer orchestrates, app image provides capabilities
- The app image is already pulled at this point in the deploy flow

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Add `curl` + AWS SigV4 signing to deployer | SigV4 signing in shell is complex and fragile; duplicates S3 logic |
| Add Node.js to deployer image | Bloats deployer from ~15MB to ~160MB; duplicates runtime |
| App container uploads on startup | Chicken-and-egg: WireGuard needs config before app starts; adds coupling |
| MinIO client (`mc`) in deployer | New dependency; yet another S3 client to maintain |
| Store keys in Terraform state | Terraform state may be shared/logged; keys are secrets |

## R2: Where should the S3 helper script live?

**Decision**: Add a `vpn-config.js` script to `poc/lib/` (alongside `s3-storage.js`).

The script accepts a command (`download` or `upload`) and a local file path. It reuses `s3-storage.js` patterns but with a configurable object key (e.g., `wg0.conf` instead of `credentials.json`).

**Rationale**:
- Co-located with the existing S3 adapter
- Can import and reuse `s3-storage.js` internals (S3 client, config)
- Runs as a standalone CLI: `node poc/lib/vpn-config.js download /opt/app/wg0.conf`
- Already in the app Docker image (no Dockerfile changes needed)

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Separate script in `deploy/` | Would need its own `package.json` and `@aws-sdk` dependency |
| Inline in `deploy.sh` | Shell can't do S3 without curl + SigV4 |
| Extend `s3-storage.js` API | Would mix credential-specific logic with generic file operations |

## R3: What S3 object key to use?

**Decision**: `wg0.conf` — same name as the file, stored in the same S3 bucket as `credentials.json`.

**Rationale**: Simple, descriptive, and follows the pattern of `credentials.json` being the key name for credentials. The bucket is already provisioned and has the right permissions.

## R4: How should the deployer invoke the S3 helper?

**Decision**: Add two steps to `deploy.sh` — download before compose up, upload after if local file exists but S3 copy doesn't.

**Flow**:
1. Copy config files (existing step)
2. Validate compose config (existing step)
3. Pull images (existing step)
4. **NEW**: Download VPN config from S3 → `/opt/app/wg0.conf` (if S3 has it)
5. **NEW**: Upload VPN config to S3 (if local exists but S3 doesn't — bootstrap)
6. Apply compose stack (existing step)

The S3 helper is invoked via:
```sh
docker run --rm --env-file "$APP_DIR/.env" \
  -v "$APP_DIR:/opt/app" \
  "$APP_IMAGE" \
  node poc/lib/vpn-config.js download /opt/app/wg0.conf
```

**Rationale**:
- Download before compose-up ensures WireGuard has config when it starts
- Upload-if-missing handles the bootstrap case (operator placed config manually)
- Uses `--env-file .env` to pass S3 credentials (already on disk from cloud-init)
- Failures are logged but non-fatal (deployer continues without VPN)

## R5: How to handle the env var for the S3 object key?

**Decision**: Use a new env var `VPN_CONFIG_KEY` (default: `wg0.conf`) to keep it configurable, similar to `CREDENTIALS_KEY`.

**Rationale**: Follows the existing pattern. The default is sensible and most users won't need to change it.
