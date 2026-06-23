# Incident Automation Setup Guide

This guide walks through setting up the Claude cloud incident-response routine for the greenhouse system. Once complete, script crashes and health-check failures automatically wake the routine, which triages the cluster and attempts safe remediation.

---

## Prerequisites

- Terraform and `kubectl` installed locally
- UpCloud Managed Kubernetes cluster already provisioned (see `deploy/terraform/`)
- Access to the Claude cloud console (claude.ai or equivalent)
- `gh` CLI authenticated for `Wnt/greenhouse-solar-heater`

---

## Step 1 — Create the Claude cloud environment

In the Claude cloud console, create a new **environment** with these settings:

### Network access

Set network access to **Custom** and add the following allowed domains:

| Domain | Purpose |
|---|---|
| `k8s.greenhouse.madekivi.fi` | Kubernetes API endpoint |
| `api.anthropic.com` | Claude API (for tool calls within the routine) |
| `*.github.com` | GitHub API (for draft PR creation) |
| `*.githubusercontent.com` | GitHub raw content |
| Default package manager registries | `apt`, `snap`, or equivalent for `kubectl` install |

### Environment variables

| Variable | Value | Notes |
|---|---|---|
| `KUBECONFIG_B64` | See below | Base64-encoded kubeconfig |

To generate `KUBECONFIG_B64`:

```bash
# From your local machine with kubectl access to the cluster
bash scripts/cloud-admin-kubeconfig.sh --base64
```

If `scripts/cloud-admin-kubeconfig.sh` does not exist yet, generate it manually:

```bash
# Export the current kubeconfig and base64-encode it
kubectl config view --raw --minify | base64 | tr -d '\n'
```

Paste the output as the value of `KUBECONFIG_B64` in the cloud environment.

### Setup script (install kubectl)

Add a setup script to install `kubectl` in the cloud environment at startup:

```bash
#!/bin/bash
set -e
# Install kubectl (stable channel)
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl
mv kubectl /usr/local/bin/kubectl
kubectl version --client
```

---

## Step 2 — Create the routine

In the Claude cloud console, create a new **routine** with these settings:

- **Name**: `greenhouse-incident-responder`
- **Instructions**: paste the full contents of `docs/incident-automation/incident-response-runbook.md`
- **Trigger**: API (this gives you a `/fire` POST endpoint and a bearer token)
- **Environment**: select the environment created in Step 1

After saving, the console shows:
- **Fire URL**: `https://api.anthropic.com/v1/routines/<id>/fire` (or similar)
- **Bearer token**: a secret token to authenticate POST requests

Copy both values — you will need them in Step 3.

---

## Step 3 — Put the fire URL and token into app secrets

The application fires the routine via `server/lib/routine-trigger.js`, which reads `CLAUDE_ROUTINE_FIRE_URL` and `CLAUDE_ROUTINE_FIRE_TOKEN` from the environment.

### Add the variables to Terraform

In `deploy/terraform/variables.tf`, add:

```hcl
variable "claude_routine_fire_url" {
  description = "Claude cloud routine /fire endpoint URL for incident response automation"
  type        = string
  default     = ""
}

variable "claude_routine_fire_token" {
  description = "Bearer token for the Claude cloud routine /fire endpoint"
  type        = string
  sensitive   = true
  default     = ""
}
```

In `deploy/terraform/main.tf`, inside the `kubernetes_secret "app_secrets"` resource's `data` block, add:

```hcl
resource "kubernetes_secret" "app_secrets" {
  metadata {
    name = "app-secrets"
  }

  data = {
    DATABASE_URL                = upcloud_managed_database_postgresql.timeseries.service_uri
    SESSION_SECRET              = var.session_secret
    S3_ENDPOINT                 = "https://${[for e in upcloud_managed_object_storage.credentials.endpoint : e.domain_name if e.type == "public"][0]}"
    S3_BUCKET                   = upcloud_managed_object_storage_bucket.credentials.name
    S3_ACCESS_KEY_ID            = upcloud_managed_object_storage_user_access_key.app.access_key_id
    S3_SECRET_ACCESS_KEY        = upcloud_managed_object_storage_user_access_key.app.secret_access_key
    S3_REGION                   = var.objsto_region
    NEW_RELIC_LICENSE_KEY       = var.new_relic_license_key
    SHELLY_CLOUD_REFRESH_TOKEN  = var.shelly_cloud_refresh_token
    SHELLY_CLOUD_API_URL        = var.shelly_cloud_api_url
    # Incident automation — leave empty to disable
    CLAUDE_ROUTINE_FIRE_URL     = var.claude_routine_fire_url
    CLAUDE_ROUTINE_FIRE_TOKEN   = var.claude_routine_fire_token
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}
```

### Set the values in terraform.tfvars

In `deploy/terraform/terraform.tfvars` (gitignored — contains real secrets):

```hcl
claude_routine_fire_url   = "https://api.anthropic.com/v1/routines/<routine-id>/fire"
claude_routine_fire_token = "<bearer-token-from-step-2>"
```

Do **not** commit real values. The `terraform.tfvars` file is in `.gitignore`.

### Apply

```bash
cd deploy/terraform
terraform apply
```

This updates the `app-secrets` Kubernetes secret. The app pod must be restarted to pick up the new env vars:

```bash
kubectl rollout restart deployment/app -n default
kubectl rollout status deployment/app -n default
```

### Verify

```bash
# Confirm the secret has the new keys (values are redacted by Kubernetes)
kubectl get secret app-secrets -n default -o jsonpath='{.data}' | \
  node -e "var d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(Object.keys(JSON.parse(d))))"

# Should include CLAUDE_ROUTINE_FIRE_URL and CLAUDE_ROUTINE_FIRE_TOKEN
```

---

## Step 4 — Set up the dead-man's-switch: in-cluster watcher + Better Stack email awareness

Two complementary mechanisms cover health monitoring. They handle different failure modes and are set up independently.

### Part A — In-cluster "watcher" Deployment (routine-firing dead-man's-switch)

The `watcher` Deployment (`deploy/k8s/watcher-deployment.yaml`) runs `server/watcher.js` in a **separate pod** using the same app image. Because it is a distinct Deployment, it keeps running if the `app` pod crash-loops or OOMs — the failure case it is designed to catch.

**What it does:**
- Polls `https://greenhouse.madekivi.fi/health` every 30 s via an outbound HTTPS GET.
- After 5 minutes of continuous failure (configurable via `WATCH_DOWN_THRESHOLD_MIN`) it fires the routine **once per outage** via `server/lib/routine-trigger`, reusing the `CLAUDE_ROUTINE_FIRE_URL` / `CLAUDE_ROUTINE_FIRE_TOKEN` already in `app-secrets` and the shared daily-budget table.
- Any 2xx response resets the down-streak and the fired flag, so a later outage fires again.
- Exposes `GET /healthz` (port 8080) for Kubernetes liveness probes.

**What it does NOT cover:** whole-node death. If the UpCloud worker node itself goes down, the watcher pod dies too and cannot fire the routine. Better Stack (Part B) covers awareness of that case.

**Deployment:** the watcher is wired into kustomize (`deploy/k8s/kustomization.yaml`) and CD (`deploy.yml`) so it is deployed automatically on every push to main. No manual steps required beyond having `watcher-deployment.yaml` applied to the cluster (happens on next CD run).

**Env vars** (all already in `app-secrets` or `app-config` from earlier steps — no new secrets needed):
- `CLAUDE_ROUTINE_FIRE_URL`, `CLAUDE_ROUTINE_FIRE_TOKEN` — from `app-secrets` (Step 3)
- `DATABASE_URL` — from `app-secrets` (needed by routine-trigger's daily-budget check)
- `WATCH_URL` — defaults to `https://greenhouse.madekivi.fi/health`; override in `app-config` if needed
- `WATCH_INTERVAL_MS`, `WATCH_DOWN_THRESHOLD_MIN`, `WATCH_TIMEOUT_MS` — defaults are 30000 / 5 / 10000; tunable via `app-config`

### Part B — Better Stack monitor (email awareness, especially for whole-node death)

Better Stack's **Free plan supports email alerts only** — outgoing webhooks are a paid feature. Set it up purely for awareness; it will not fire the routine directly.

1. Create a free account at [betterstack.com](https://betterstack.com)
2. Add a new **Monitor**:
   - **URL**: `https://greenhouse.madekivi.fi/health`
   - **Check frequency**: 1 minute
   - **Expected HTTP status**: 200
   - **Confirmation period**: 5 minutes — this means Better Stack emails you only after 5+ consecutive minutes of failure, filtering out transient blips and matching the watcher's threshold.
3. Under **Notifications**, add your email address. Leave outgoing webhooks unconfigured (they require a paid plan).

This gives you an email when the endpoint has been down for ≥5 min — including the whole-node-death scenario where the watcher cannot act. The in-cluster watcher handles the auto-remediable case (app crash-loop / OOM while the node is healthy); Better Stack's email covers the rest.

### Keep each outage to ~one routine fire

Routine runs are a capped daily resource (see your allowance at [claude.ai/code/routines](https://claude.ai/code/routines)) and every `/fire` spends one. The watcher fires **once per outage** by design (the fired flag is only reset on UP), and the shared `routine_fires` daily-budget table enforces the cap cluster-wide. No extra configuration needed.

---

## Step 5 — Budget the cluster-side fires

The app fires the routine for control-system anomalies via `server/lib/routine-trigger.js`, which enforces its own budget so a recurring anomaly can't drain your daily allowance:

- **`ROUTINE_FIRE_DAILY_CAP`** (default `10`) — hard limit on `/fire` calls per rolling 24 h, counted in a `routine_fires` DB table. It is **durable across pod restarts** (an in-process counter would reset on exactly the crash-loops that fire). Over the cap, the fire is suppressed and only the PWA push is sent — push is free.
- **`ROUTINE_FIRE_COOLDOWN_MIN`** (default `15`) — per-kind cooldown; the same incident kind fires at most once per window.

Set these in `app-config` (they aren't secrets). Size the daily cap to roughly **half** your subscription's daily routine-run allowance, leaving headroom for the dead-man's-switch monitor and your own manual/test runs:

```
ROUTINE_FIRE_DAILY_CAP=10
ROUTINE_FIRE_COOLDOWN_MIN=15
```

The two sources fire for mutually-exclusive incident types — Better Stack only when the server is **down**, the cluster only when the server is **up** with a control anomaly — so they rarely both fire for one incident and their budgets are effectively independent. Worst-case daily fires ≈ (distinct outages) + `ROUTINE_FIRE_DAILY_CAP`; size both to stay under your allowance.

---

## Verification checklist

After completing all steps:

- [ ] `kubectl get pods -n default` runs from the cloud environment
- [ ] `curl -s https://greenhouse.madekivi.fi/health` returns `{"status":"ok"}`
- [ ] A test POST to the routine fire URL (with correct headers and body `{"text":"test"}`) triggers the routine and it responds
- [ ] The Kubernetes secret includes `CLAUDE_ROUTINE_FIRE_URL` and `CLAUDE_ROUTINE_FIRE_TOKEN`
- [ ] `kubectl get deployment watcher -n default` shows the watcher Deployment as available (1/1 Ready)
- [ ] `kubectl get pods -n default -l app=watcher` shows the watcher pod Running
- [ ] `kubectl exec deployment/watcher -- curl -s http://localhost:8080/healthz` returns HTTP 200
- [ ] Killing the `app` pod (e.g. `kubectl delete pod -l app=greenhouse`) and leaving it crash-looping for >5 min causes the watcher to fire the routine (check `kubectl logs deployment/watcher` for "fired routine" log line and verify the routine ran)
- [ ] Any UP result after a down-streak resets the watcher state so a subsequent outage fires again (visible in watcher logs)
- [ ] `PREVIEW_MODE` pods never fire the routine (gated in `server/lib/routine-trigger.js`); the watcher Deployment does not set `PREVIEW_MODE`
- [ ] Better Stack monitor is configured with a **5-minute Confirmation period** so it emails only after a real outage (not transient blips)
- [ ] Better Stack sends an email alert for whole-node death scenarios (watcher cannot cover this case)
- [ ] `ROUTINE_FIRE_DAILY_CAP` is set to ~half your daily routine-run allowance, leaving headroom for the watcher and manual runs
