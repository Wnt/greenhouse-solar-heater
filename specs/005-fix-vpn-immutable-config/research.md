# Research: Mutable Server Configuration

**Feature**: 005-fix-vpn-immutable-config
**Date**: 2026-03-21

## Research Question 1: What exactly triggers server recreation?

### Findings

Analysis of `deploy/terraform/main.tf` reveals that `enable_vpn` is used in only one place: the `upcloud_firewall_rules.monitor` resource (lines 141-152). This is a **separate Terraform resource** from `upcloud_server.monitor`. Changing `enable_vpn` modifies `upcloud_firewall_rules.monitor`, NOT the server itself.

However, the **real problem** is that fully enabling VPN requires more than just a firewall rule:
1. **Firewall rule** (port 51820/UDP) — already in a separate resource, no server recreation
2. **`COMPOSE_PROFILES=vpn`** — needed so docker-compose starts the wireguard service. Currently NOT in the `.env` file at all.
3. **`VPN_CHECK_HOST`** — currently hardcoded to `""` in cloud-init `user_data` (line 31 of `cloud-init.yaml`). Changing it to a real value would change `user_data`, which forces server recreation.

So the firewall part is fine, but enabling the VPN container requires modifying `.env`, which is embedded in `user_data`. Any `user_data` change triggers UpCloud to destroy and recreate the server.

### Decision

The `.env` file must be split into immutable secrets (cloud-init) and mutable service config (deployer-managed). This decouples operational configuration changes from server lifecycle.

---

## Research Question 2: How should mutable config be delivered to the server?

### Alternatives Considered

| Approach | Pros | Cons |
|----------|------|------|
| **A: Bake into deployer image** | Follows existing pattern (like docker-compose.yml, Caddyfile). Version-controlled. Deploys automatically via CD. | VPN toggle requires two steps: git push + terraform apply for firewall. |
| **B: Store in S3, Terraform writes** | Single `terraform apply` toggles everything. | Requires adding AWS Terraform provider for one S3 object. Adds provider complexity. S3 credentials have circular dependency risk. |
| **C: UpCloud server metadata API** | Server queries its own metadata. | Metadata is part of `user_data` — same recreation problem. |
| **D: Manual .env edit via console** | Zero infrastructure changes. | Fragile, lost on recreation, no version control, no automation. |

### Decision: Approach A — Bake mutable config into deployer image

**Rationale**:
- Follows the existing deployer pattern exactly. The deployer already copies `docker-compose.yml` and `Caddyfile` from its image to `/opt/app/`. Adding `config.env` is the same pattern.
- Config changes are version-controlled in git and deploy automatically via the CD pipeline.
- No new Terraform providers or S3 write mechanisms needed.
- The UpCloud Terraform provider does NOT have an object storage object resource, so Approach B would require adding the full AWS provider just for one S3 put — disproportionate complexity.

**Trade-off accepted**: Enabling VPN becomes a two-step process:
1. Set `COMPOSE_PROFILES=vpn` in `deploy/deployer/config.env` + git push → deployer image rebuilds, VPN container starts on next cycle
2. `terraform apply` with `enable_vpn=true` → opens firewall port

Order doesn't matter: if the container starts before the firewall opens, it just can't receive connections. If the firewall opens first, packets are dropped at the container level. Both steps converge to the working state within one deployer cycle (~5 min).

---

## Research Question 3: How should the deployer merge secrets and config?

### Findings

Docker Compose supports multiple `env_file` entries. Later files override earlier ones:

```yaml
env_file:
  - .env.secrets
  - .env.config
```

However, this requires modifying `docker-compose.yml` and the deployer's S3 operations (which use `--env-file .env`).

A simpler approach: the deployer merges the two files into a single `.env` on each cycle. The merge script:
1. Reads `.env.secrets` (written once by cloud-init, contains S3 creds, session secret, etc.)
2. Reads `config.env` (copied from deployer image, contains COMPOSE_PROFILES, VPN_CHECK_HOST, etc.)
3. Writes merged `.env` (config values override secrets for any duplicate keys)
4. Existing docker-compose.yml, deploy.sh S3 operations, and container env_file references are unchanged.

### Decision: Deployer-side merge to single `.env`

**Rationale**: Minimizes changes to existing infrastructure. The deployer already writes files to `/opt/app/`. Adding a merge step keeps docker-compose.yml, the S3 helper invocations, and container configurations untouched.

---

## Research Question 4: What belongs in secrets vs. config?

### Decision

**`.env.secrets`** (cloud-init, immutable — changing these IS worth a server recreation):
- `SESSION_SECRET` — HMAC signing key
- `S3_ENDPOINT` — Object storage endpoint
- `S3_BUCKET` — Bucket name
- `S3_ACCESS_KEY_ID` — S3 access key
- `S3_SECRET_ACCESS_KEY` — S3 secret key
- `S3_REGION` — S3 region

**`config.env`** (deployer image, mutable — changes deploy automatically):
- `PORT=3000`
- `AUTH_ENABLED=true`
- `RPID=${domain}` — derived from domain, rarely changes
- `ORIGIN=https://${domain}` — derived from domain, rarely changes
- `DOMAIN=${domain}` — for Caddy
- `GITHUB_REPO=${github_repo}` — for image pulls
- `VPN_CHECK_HOST` — empty or set to VPN peer IP
- `VPN_CONFIG_KEY=wg0.conf`
- `SETUP_WINDOW_MINUTES=30`
- `NODE_ENV=production`
- `COMPOSE_PROFILES` — empty (default) or `vpn` (when VPN enabled)

**Rationale**: Secrets are values that, if leaked, compromise security. Everything else is operational config that should be changeable without downtime. Domain-related values (`RPID`, `ORIGIN`, `DOMAIN`) are in config because changing the domain is a rare but legitimate operation that shouldn't force server recreation.

---

## Research Question 5: What about `GITHUB_REPO` and domain values in config.env?

### Findings

The deployer image is built by GitHub Actions, which has access to `${{ github.repository }}`. The domain is stored in Terraform variables. These values need to be in `config.env` but aren't available at image build time.

However, `GITHUB_REPO` IS available in GitHub Actions (it's the repo building the image). And the domain is relatively static — it changes perhaps once in the lifetime of the project.

### Decision

- `GITHUB_REPO` is set in `config.env` at build time using the GitHub Actions `GITHUB_REPOSITORY` env var, injected as a Docker build arg.
- `DOMAIN`, `RPID`, `ORIGIN` are set in `config.env` as a checked-in config file. When the domain changes, update the file and push — the deployer applies it.
- For initial setup, these values must match what Terraform provisions. Document this in a quickstart guide.

This means `config.env` is a **checked-in file** in the repo at `deploy/deployer/config.env`, with some values templated at build time (GITHUB_REPO) and others set manually (domain, VPN settings).

---

## Summary of Approach

```
cloud-init (immutable)          deployer image (mutable, CD pipeline)
  └─ .env.secrets                 ├─ docker-compose.yml
     ├─ SESSION_SECRET            ├─ Caddyfile
     ├─ S3_ENDPOINT               └─ config.env
     ├─ S3_BUCKET                    ├─ PORT, AUTH_ENABLED
     ├─ S3_ACCESS_KEY_ID             ├─ DOMAIN, RPID, ORIGIN
     ├─ S3_SECRET_ACCESS_KEY         ├─ GITHUB_REPO
     └─ S3_REGION                    ├─ COMPOSE_PROFILES
                                     ├─ VPN_CHECK_HOST
                                     └─ NODE_ENV, etc.

Deployer merge step:
  .env.secrets + config.env → .env (merged, secrets take precedence for dupes)
```
