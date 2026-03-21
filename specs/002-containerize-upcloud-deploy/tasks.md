# Tasks: Containerize UpCloud Deployment

**Feature**: 002-containerize-upcloud-deploy
**Created**: 2026-03-21

## Phase 1: S3 Storage Adapter (App Code)

- [X] T01: Create S3 storage adapter `poc/lib/s3-storage.js` with read/write/fallback-to-fs
- [X] T02: Write unit tests for S3 storage adapter `tests/s3-storage.test.js`
- [X] T03: Modify `poc/auth/credentials.js` to use S3 storage adapter instead of direct fs
- [X] T04: Add `@aws-sdk/client-s3` to package.json dependencies
- [X] T05: Run existing tests to verify no regressions

## Phase 2: Docker Hardening

- [X] T06: Update `deploy/docker/Dockerfile` — non-root user, RO-compatible
- [X] T07: Update `deploy/docker/docker-compose.yml` — read-only root, non-root, Watchtower, VPN profile
- [X] T08: Update `.dockerignore` with correct patterns

## Phase 3: Terraform Refactor

- [X] T09: Update `deploy/terraform/variables.tf` — add `enable_vpn`, remove SSH-only vars
- [X] T10: Update `deploy/terraform/main.tf` — add object storage, VPN toggle, remove SSH firewall
- [X] T11: Update `deploy/terraform/outputs.tf` — add S3 endpoint and credentials outputs
- [X] T12: Rewrite `deploy/terraform/cloud-init.yaml` — remove WireGuard host install, write docker-compose + env
- [X] T13: Update `deploy/terraform/terraform.tfvars.example`
- [X] T14: Run `terraform fmt` and `terraform validate`

## Phase 4: CI/CD Pipeline

- [X] T15: Update `.github/workflows/deploy.yml` — remove SSH deploy, simplify to build+push
- [X] T16: Update `deploy/README.md` with new deployment workflow

## Phase 5: Verification

- [X] T17: Run full test suite (`npm test`) to verify everything passes
- [X] T18: Update CLAUDE.md with architectural changes
