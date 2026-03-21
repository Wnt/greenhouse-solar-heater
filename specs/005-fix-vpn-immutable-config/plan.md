# Implementation Plan: Mutable Server Configuration

**Branch**: `005-fix-vpn-immutable-config` | **Date**: 2026-03-21 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/005-fix-vpn-immutable-config/spec.md`

## Summary

Split the server's `.env` file — currently baked entirely into cloud-init `user_data` — into two layers: immutable secrets (cloud-init) and mutable service config (deployer image). This lets operators toggle VPN and other optional components without server recreation, avoiding downtime and DNS re-pointing.

The deployer already copies `docker-compose.yml` and `Caddyfile` from its image to the host. Adding a `config.env` file follows the same pattern. On each cycle, the deployer merges `.env.secrets` (cloud-init) + `config.env` (deployer image) → `.env` (consumed by Docker Compose).

## Technical Context

**Language/Version**: HCL (Terraform >= 1.5), POSIX shell (deployer), YAML (cloud-init, docker-compose)
**Primary Dependencies**: UpCloud Terraform provider ~> 5.0, Docker Compose v2, systemd
**Storage**: UpCloud Managed Object Storage (S3-compatible) for VPN config and credentials
**Testing**: `terraform plan` validation, deployer merge logic unit testing (shell)
**Target Platform**: UpCloud Linux server (Ubuntu 24.04 LTS)
**Project Type**: Infrastructure / deployment configuration
**Performance Goals**: N/A (infrastructure change, not application performance)
**Constraints**: No SSH access to server; all changes must flow through deployer or Terraform. No new Terraform providers.
**Scale/Scope**: Single server, ~3 config files modified, ~1 new file added

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | No hardware changes |
| II. Pure Logic / IO Separation | N/A | No control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Deployer merge preserves existing behavior if config.env is missing. Secrets file takes precedence in merge conflicts. |
| IV. Proportional Test Coverage | PASS | Changes are infrastructure config. Verification via `terraform plan` output. Deployer merge step should have basic validation. |
| V. Token-Based Cloud Auth | PASS | No auth changes. UpCloud Terraform provider still uses `UPCLOUD_TOKEN`. |
| VI. Durable Data Persistence | PASS | Secrets persist in cloud-init (survives deployer cycles). Config persists in git/deployer image (survives server recreation via CD rebuild). Merged `.env` regenerated every cycle. |

**Post-Phase-1 re-check**: All gates still pass. No new providers, no new storage mechanisms, no safety-critical changes.

## Project Structure

### Documentation (this feature)

```text
specs/005-fix-vpn-immutable-config/
├── plan.md              # This file
├── research.md          # Phase 0: design decisions and alternatives
├── data-model.md        # Phase 1: env file layout and merge rules
├── quickstart.md        # Phase 1: operator workflows
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
deploy/
├── terraform/
│   ├── main.tf              # MODIFY: cloud-init writes .env.secrets instead of .env
│   ├── cloud-init.yaml      # MODIFY: secrets-only .env.secrets, remove non-secret vars
│   ├── variables.tf         # NO CHANGE (enable_vpn already exists)
│   └── outputs.tf           # NO CHANGE
├── deployer/
│   ├── deploy.sh            # MODIFY: add merge step (.env.secrets + config.env → .env)
│   ├── config.env           # NEW: mutable service configuration
│   ├── docker-compose.yml   # NO CHANGE
│   ├── Caddyfile            # NO CHANGE
│   └── Dockerfile           # MODIFY: copy config.env into image
└── docker/
    └── Dockerfile           # NO CHANGE

tests/
└── vpn-config.test.js       # EXISTING: may need updates if env var handling changes
```

**Structure Decision**: All changes are within existing `deploy/` directory structure. One new file (`deploy/deployer/config.env`). No new directories needed.

## Implementation Steps

### Step 1: Create `deploy/deployer/config.env`

Create the mutable config file with all non-secret environment variables currently in cloud-init:

```env
PORT=3000
AUTH_ENABLED=true
RPID=greenhouse.example.com
ORIGIN=https://greenhouse.example.com
DOMAIN=greenhouse.example.com
GITHUB_REPO=owner/repo
VPN_CHECK_HOST=
VPN_CONFIG_KEY=wg0.conf
SETUP_WINDOW_MINUTES=30
NODE_ENV=production
COMPOSE_PROFILES=
```

Note: `RPID`, `ORIGIN`, `DOMAIN`, and `GITHUB_REPO` need actual values set by the operator. Document this in quickstart.

### Step 2: Update `deploy/deployer/Dockerfile`

Add `COPY config.env /config/config.env` alongside existing config file copies.

### Step 3: Update `deploy/deployer/deploy.sh`

Add a merge step before the existing compose validation:

1. Copy `config.env` from image to host (like docker-compose.yml and Caddyfile)
2. If `.env.secrets` exists, merge: start with `config.env`, then overlay `.env.secrets` (secrets win)
3. Write merged result to `.env`
4. If `.env.secrets` does NOT exist (legacy server or first boot race), fall back to existing `.env` if present

The merge must be simple POSIX shell (the deployer base image is `docker:cli` / Alpine).

### Step 4: Update `deploy/terraform/cloud-init.yaml`

Change the `.env` write to `.env.secrets` and include ONLY secret values:

```yaml
- path: /opt/app/.env.secrets
  permissions: "0600"
  content: |
    SESSION_SECRET=${session_secret}
    S3_ENDPOINT=${s3_endpoint}
    S3_BUCKET=${s3_bucket}
    S3_ACCESS_KEY_ID=${s3_access_key_id}
    S3_SECRET_ACCESS_KEY=${s3_secret_key}
    S3_REGION=${s3_region}
```

Remove all non-secret values (`PORT`, `AUTH_ENABLED`, `RPID`, `ORIGIN`, `DOMAIN`, `GITHUB_REPO`, `VPN_CHECK_HOST`, `VPN_CONFIG_KEY`, `SETUP_WINDOW_MINUTES`, `NODE_ENV`).

### Step 5: Update `deploy/terraform/main.tf`

Update the `templatefile` call to remove variables that are no longer in cloud-init:
- Remove `domain`, `github_repo`, `vpn_check_host` from the template variables
- Keep only the secret-related variables

### Step 6: Update GitHub Actions CD workflow

Ensure the deployer image build copies `config.env`. If `GITHUB_REPO` needs to be injected at build time (rather than checked into the file), add a build arg to the deployer Dockerfile.

### Step 7: Update CLAUDE.md

Document the new config split:
- `.env.secrets` — cloud-init, secrets only
- `config.env` — deployer image, mutable service config
- `.env` — deployer merge output, consumed by Docker Compose

## Migration Strategy

For an existing deployed server:

1. Deploy the new deployer image (via CD push)
2. On next deployer cycle, `config.env` is copied to `/opt/app/`
3. Deployer detects `.env` exists but `.env.secrets` does not (legacy state)
4. Deployer falls back: uses existing `.env` as-is (no merge, no breakage)
5. When the operator is ready, run `terraform apply` (with the updated cloud-init)
6. If server is recreated (due to cloud-init change), cloud-init writes `.env.secrets`
7. On first deployer cycle after recreation, merge works: `.env.secrets` + `config.env` → `.env`

**Important**: The cloud-init change WILL trigger one final server recreation (because `user_data` changes from writing `.env` to writing `.env.secrets`). After that migration, no further service-level config changes will trigger recreation.
