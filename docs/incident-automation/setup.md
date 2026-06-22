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

## Step 4 — Set up an external dead-man's-switch health monitor

Even when the app is down (crash-loop or OOM), the health-check monitor can fire the routine directly. Use a free external uptime monitor.

### Option A: Healthchecks.io (recommended, free tier)

1. Create a free account at [healthchecks.io](https://healthchecks.io)
2. Create a new check:
   - **Name**: `greenhouse-health`
   - **Period**: 1 minute
   - **Grace time**: 2 minutes
3. Under **Integrations**, add a **Webhook** that fires on DOWN:
   - **URL**: `<CLAUDE_ROUTINE_FIRE_URL>` (from Step 2)
   - **Method**: POST
   - **Headers**: `Authorization: Bearer <CLAUDE_ROUTINE_FIRE_TOKEN>`, `Content-Type: application/json`, `anthropic-version: 2023-06-01`, `anthropic-beta: experimental-cc-routine-2026-04-01`
   - **Body**: `{"text": "Health check failed: greenhouse.madekivi.fi/health is DOWN"}`

4. Set Healthchecks.io to monitor `https://greenhouse.madekivi.fi/health` by pinging the check URL every minute from a cron job or using their built-in URL monitoring:

   ```bash
   # Add to system crontab or a monitoring service:
   * * * * * curl -fsS --retry 3 \
     https://hc-ping.com/<your-check-uuid> \
     -w "%{http_code}" \
     --output /dev/null \
     || true
   ```

   Alternatively, use Healthchecks.io's **URL monitoring** feature (requires a paid plan) to monitor `https://greenhouse.madekivi.fi/health` directly.

### Option B: Better Stack (BetterUptime, free tier)

1. Create a free account at [betterstack.com](https://betterstack.com)
2. Add a new **Monitor**:
   - **URL**: `https://greenhouse.madekivi.fi/health`
   - **Check frequency**: 1 minute
   - **Expected HTTP status**: 200
3. Under **Escalation policies**, add an **HTTP webhook** on incident:
   - **URL**: `<CLAUDE_ROUTINE_FIRE_URL>`
   - **Method**: POST
   - **Headers**: same as Healthchecks.io above
   - **Body**: `{"text": "Better Stack: greenhouse.madekivi.fi/health is DOWN — trigger incident response"}`

---

## Verification checklist

After completing all steps:

- [ ] `kubectl get pods -n default` runs from the cloud environment
- [ ] `curl -s https://greenhouse.madekivi.fi/health` returns `{"status":"ok"}`
- [ ] A test POST to the routine fire URL (with correct headers and body `{"text":"test"}`) triggers the routine and it responds
- [ ] The Kubernetes secret includes `CLAUDE_ROUTINE_FIRE_URL` and `CLAUDE_ROUTINE_FIRE_TOKEN`
- [ ] The uptime monitor fires a DOWN webhook when the health endpoint is unreachable (test by temporarily blocking the health endpoint in a preview deploy, or by manually triggering the webhook from the monitor's dashboard)
- [ ] `PREVIEW_MODE` pods never fire the routine (gated in `server/lib/routine-trigger.js`)
