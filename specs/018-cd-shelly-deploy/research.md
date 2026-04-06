# Research: CD Pipeline Shelly Script Deployment

## Key Findings

### Container Readiness

The app container already has everything needed to run `deploy.sh`:
- **bash**: Available in node:22-alpine base image
- **python3**: Explicitly installed (`apk add --no-cache curl python3`)
- **curl**: Explicitly installed
- **shelly/ directory**: Copied into `/app/shelly/` (Dockerfile line 20: `COPY shelly/ ./shelly/`)
- **Network**: Pod has VPN access to Shelly devices via OpenVPN sidecar

### Environment Variables in Pod

Available from ConfigMap (relevant to deploy):
- `CONTROLLER_IP=192.168.30.10`
- `CONTROLLER_SCRIPT_ID=1`
- `MQTT_HOST=localhost`

### RBAC Limitation

The deployer ServiceAccount (used by GitHub Actions) has minimal permissions:
- `deployments`: get, patch, list, watch (resource name: "app")
- `replicasets`: get, list, watch
- `pods`: get, list, watch

**Missing**: `pods/exec` — required for `kubectl exec`. The deployer cannot currently exec into pods.

### Read-Only Filesystem

The app container has `readOnlyRootFilesystem: true`. Only `/tmp` (emptyDir) is writable. This doesn't affect `deploy.sh` since it only reads files from `/app/shelly/` and makes HTTP requests — no local writes needed.

## Decision: kubectl exec with RBAC extension

**Chosen approach**: Add `pods/exec` permission to the deployer ServiceAccount Role, then add a CD pipeline step that runs `kubectl exec` into the app pod to execute `deploy.sh` after rollout completes.

**Rationale**:
- Minimal change — reuses existing `deploy.sh` as-is
- Runs inside the pod which already has VPN access and all dependencies
- The deployer already has pod get/list/watch, adding exec is a small, scoped escalation
- Alternative (init container or startup script) would couple Shelly deployment to every pod restart, not just code deployments

**Alternatives considered**:
1. **Init container**: Runs deploy.sh before app starts. Rejected — would delay app startup and run on every pod restart (not just code pushes). Also, VPN sidecar may not be ready during init.
2. **Post-start lifecycle hook**: Similar timing issues with VPN readiness. Also runs on every restart.
3. **Kubernetes Job**: Separate Job that execs or runs deploy.sh. More complex, needs its own image and RBAC. Overkill.
4. **Separate ServiceAccount**: A dedicated exec-only SA for Shelly deploys. More secure but unnecessary complexity — the deployer already has write access to the deployment.

## VPN Readiness

The deploy step must wait for VPN connectivity. The OpenVPN sidecar starts in parallel with the app. Approach: poll the Shelly device IP with a short timeout before running deploy.sh. The existing `VPN_CHECK_HOST` environment variable can be used for this health check.

## Deploy Script Usage

From inside the pod:
```bash
cd /app/shelly && DEPLOY_VIA_VPN=true bash deploy.sh
```

This uses `PRO4PM_VPN` from `devices.conf` which resolves to `${CONTROLLER_VPN_IP:-192.168.30.10}`. Since `CONTROLLER_VPN_IP` is empty in the ConfigMap, it falls back to `192.168.30.10`.
