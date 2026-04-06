# Quickstart: CD Pipeline Shelly Script Deployment

## What Changed

1. **Deployer RBAC** (`deploy/terraform/main.tf`): Added `pods/exec` permission so the CD pipeline can exec into the app pod.
2. **CD Pipeline** (`.github/workflows/deploy.yml`): Added `shelly-deploy` job that runs after app deployment, execs into the pod, and runs `deploy.sh` to upload scripts to the Shelly Pro 4PM.

## How It Works

```
Push to main
  → CI tests pass
  → Build app + openvpn images
  → Deploy: kubectl set image → rollout
  → Shelly Deploy (NEW):
      1. Wait for VPN connectivity (poll Shelly device, up to 60s)
      2. kubectl exec into app pod
      3. Run DEPLOY_VIA_VPN=true deploy.sh
      4. Scripts uploaded to Shelly Pro 4PM
```

## Verifying

After pushing to main, check the GitHub Actions run:

```bash
# View the latest deploy run
gh run list --workflow=deploy.yml --limit 1

# Check the shelly-deploy job output
gh run view <run-id> --log | grep -A 20 "shelly-deploy"
```

The `shelly-deploy` job shows as green (success) or yellow (skipped/failed but non-fatal). The overall pipeline always succeeds even if Shelly deploy fails.

## Manual Shelly Deploy

If you need to deploy manually (e.g., VPN was down during CD):

```bash
# From inside the cluster
kubectl exec deployment/app -c app -- sh -c 'cd /app/shelly && DEPLOY_VIA_VPN=true bash deploy.sh'

# From local network (if you have direct access)
cd shelly && bash deploy.sh
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "VPN not ready after 60s" | OpenVPN sidecar hasn't connected | Check openvpn logs: `kubectl logs deployment/app -c openvpn` |
| "Connection refused" to Shelly | Device offline or IP changed | Verify device IP matches `devices.conf` |
| RBAC error on kubectl exec | Deployer SA lacks pods/exec | Run `terraform apply` to update RBAC |
| Script upload timeout | Shelly device busy or network issue | Retry manually or wait for next push |
