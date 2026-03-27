# Implementation Plan: Migrate to UpCloud Managed Kubernetes

**Branch**: `014-migrate-upcloud-kubernetes` | **Date**: 2026-03-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/014-migrate-upcloud-kubernetes/spec.md`

## Summary

Migrate the greenhouse monitoring application from a single UpCloud cloud server running Docker Compose to UpCloud Managed Kubernetes (UKS). The migration replaces the deployer-based pull model with direct CI/CD deployment via kubectl, moves from Caddy to NGINX Ingress with cert-manager for TLS, and runs OpenVPN + Mosquitto as sidecar containers in the app pod. The existing Managed PostgreSQL and Object Storage resources are reused. Target cost: EUR 15-25/month (matching current baseline) using the free development control plane, a single DEV-1xCPU-1GB worker node, and no managed load balancer.

## Technical Context

**Language/Version**: HCL (Terraform >= 1.5), YAML (Kubernetes manifests), POSIX shell (CI scripts), Node.js 20 LTS (app, unchanged)
**Primary Dependencies**: UpCloud Terraform provider ~> 5.0, Kubernetes provider ~> 2.24, Helm provider ~> 2.12, kubectl, cert-manager, NGINX Ingress controller
**Storage**: UpCloud Managed PostgreSQL with TimescaleDB (unchanged), UpCloud Managed Object Storage (unchanged)
**Testing**: `terraform validate`, `kubectl diff`, manual smoke test of deployed services, existing `npm test` suite (unchanged)
**Target Platform**: UpCloud Managed Kubernetes (UKS), fi-hel1 zone
**Project Type**: Infrastructure / deployment platform migration
**Performance Goals**: Same as current — single-user system, no throughput requirements
**Constraints**: EUR 15-25/month budget, single DEV-1xCPU-1GB worker node (1GB RAM), no managed load balancer, no HA requirements
**Scale/Scope**: 1 cluster, 1 node, 1 pod (3 containers), 1 ingress

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | Infrastructure-only change, no hardware/system.yaml impact |
| II. Pure Logic / IO Separation | N/A | No control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Security posture preserved: non-root containers, read-only root filesystems, NET_ADMIN (not privileged) for VPN, passkey auth unchanged |
| IV. Proportional Test Coverage | PASS | Existing test suite unchanged. Infrastructure tested via `terraform validate` and deployment smoke tests |
| V. Token-Based Cloud Auth | PASS | Terraform uses `UPCLOUD_TOKEN`. CI uses kubeconfig/service account token for K8s API access |
| VI. Durable Data Persistence | PASS | PostgreSQL and S3 Object Storage persist data externally. K8s Secrets provisioned by Terraform (source of truth in Terraform state + S3). Pod-local storage is ephemeral (emptyDir) as intended |
| VII. No Secrets in Cloud-Init | PASS | Cloud-init is eliminated entirely. Secrets flow: Terraform provisions resources → stores credentials as K8s Secrets → pods consume via env vars. S3 remains the durable store for VPN config and database URL |

**Post-Phase 1 Re-check**: All gates still pass. The design uses Terraform to provision K8s Secrets from resource outputs (DATABASE_URL, S3 credentials), eliminating cloud-init entirely. The S3 bootstrap pattern is replaced by Terraform-managed K8s Secrets, which is a cleaner version of the same principle.

## Project Structure

### Documentation (this feature)

```text
specs/014-migrate-upcloud-kubernetes/
├── plan.md              # This file
├── research.md          # Phase 0: technical research findings
├── data-model.md        # Phase 1: Kubernetes resource model
├── quickstart.md        # Phase 1: migration quickstart guide
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
deploy/
├── terraform/
│   ├── main.tf              # Updated: replace cloud server with UKS cluster
│   ├── variables.tf         # Updated: new K8s variables, remove server variables
│   ├── outputs.tf           # Updated: kubeconfig output
│   └── cloud-init.yaml      # Removed: no longer needed
├── k8s/
│   ├── namespace.yaml       # New: app namespace
│   ├── app-deployment.yaml  # New: app + openvpn + mosquitto pod
│   ├── services.yaml        # New: ClusterIP for app
│   ├── ingress.yaml         # New: NGINX Ingress with TLS
│   ├── configmap.yaml       # New: app config, mosquitto config
│   ├── cert-manager.yaml    # New: ClusterIssuer for Let's Encrypt
│   └── kustomization.yaml   # New: kustomize base for CD
├── docker/
│   └── Dockerfile           # Unchanged
├── openvpn/
│   └── Dockerfile           # Unchanged
├── deployer/                # Removed: entire directory (replaced by kubectl)
│   ├── Dockerfile           # Removed
│   ├── deploy.sh            # Removed
│   ├── docker-compose.yml   # Removed
│   ├── Caddyfile            # Removed
│   └── config.env           # Removed (moved to K8s ConfigMap)
└── upcloud-docs/            # Unchanged (reference only)

.github/workflows/
├── ci.yml                   # Unchanged
├── deploy.yml               # Updated: build images + kubectl apply (remove deployer build)
├── deploy-pages.yml         # Unchanged
└── lint-shelly.yml          # Unchanged
```

**Structure Decision**: The existing `deploy/` directory structure is extended with a new `deploy/k8s/` directory for Kubernetes manifests. The `deploy/deployer/` directory is removed entirely since the deployer container pattern is replaced by direct kubectl deployment from CI. Terraform in `deploy/terraform/` is updated in-place to replace the cloud server with a UKS cluster. Kustomize is used for manifest management (lightweight, no Helm chart needed for this scale).

## Complexity Tracking

No constitution violations to justify.
