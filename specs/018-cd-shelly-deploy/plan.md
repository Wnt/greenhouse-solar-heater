# Implementation Plan: CD Pipeline Shelly Script Deployment

**Branch**: `018-cd-shelly-deploy` | **Date**: 2026-04-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/018-cd-shelly-deploy/spec.md`

## Summary

Add a post-deployment step to the GitHub Actions CD pipeline that uses `kubectl exec` to run `shelly/deploy.sh` inside the app pod, deploying updated Shelly scripts to the Pro 4PM via the pod's VPN connection. Requires adding `pods/exec` permission to the deployer ServiceAccount RBAC.

## Technical Context

**Language/Version**: YAML (GitHub Actions), HCL (Terraform), Bash
**Primary Dependencies**: kubectl, GitHub Actions, Kubernetes RBAC
**Storage**: N/A
**Testing**: Manual verification via pipeline logs; unit tests not applicable for CI workflow changes
**Target Platform**: GitHub Actions → Kubernetes cluster (UpCloud UKS)
**Project Type**: CI/CD pipeline enhancement
**Constraints**: Deployer RBAC must remain minimal; Shelly deploy failure must not block app deployment
**Scale/Scope**: Single workflow file change + RBAC update

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Status |
|-----------|----------|--------|
| I. system.yaml as source of truth | No | N/A — no hardware spec changes |
| II. Pure Logic / IO Separation | No | N/A — no control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | Yes | ✅ Deploy failure is non-fatal (pipeline continues) |
| IV. Proportional Test Coverage | Yes | ✅ CI workflow changes — no unit-testable logic added |
| V. Token-Based Cloud Auth | Yes | ✅ Uses existing KUBE_CONFIG_DATA secret (no UpCloud credentials) |
| VI. Durable Data Persistence | No | N/A — no persistent data changes |
| VII. No Secrets in Cloud-Init | No | N/A — no cloud-init changes |

No violations.

## Project Structure

### Documentation (this feature)

```text
specs/018-cd-shelly-deploy/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
.github/workflows/deploy.yml     # Add shelly-deploy job
deploy/terraform/main.tf          # Add pods/exec RBAC verb
deploy/k8s/deployer-rbac.yaml     # Add pods/exec RBAC verb (if used)
```

**Structure Decision**: Changes are confined to CI/CD configuration — no new source directories needed.

## Implementation Approach

### Step 1: Extend Deployer RBAC

Add `pods/exec` to the deployer Role in `deploy/terraform/main.tf`. The pod rule currently allows `["get", "list", "watch"]` — add `"create"` on `pods/exec` subresource (kubectl exec uses a POST/create on the exec subresource).

### Step 2: Add Shelly Deploy Job to CD Pipeline

Add a new job `shelly-deploy` in `.github/workflows/deploy.yml` that:

1. Depends on the `deploy` job (runs after rollout completes)
2. Configures kubeconfig from `KUBE_CONFIG_DATA` secret
3. Waits for VPN connectivity by polling the Shelly device from inside the pod
4. Runs `kubectl exec` into the app pod to execute `deploy.sh`
5. Uses `continue-on-error: true` so failures don't block the pipeline

### Step 3: VPN Readiness Check

Before running deploy.sh, the pipeline step should verify VPN connectivity:
```bash
# Wait up to 60s for VPN to come up
kubectl exec deployment/app -c app -- sh -c '
  for i in $(seq 1 12); do
    curl -sf --connect-timeout 3 http://192.168.30.10/rpc/Shelly.GetStatus > /dev/null 2>&1 && exit 0
    sleep 5
  done
  echo "VPN not ready after 60s" >&2
  exit 1
'
```

### Step 4: Execute Deploy

```bash
kubectl exec deployment/app -c app -- sh -c '
  cd /app/shelly && DEPLOY_VIA_VPN=true bash deploy.sh
'
```
