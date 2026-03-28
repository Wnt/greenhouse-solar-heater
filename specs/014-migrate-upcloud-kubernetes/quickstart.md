# Quickstart: Kubernetes Migration

## Prerequisites

- Terraform >= 1.5 installed
- kubectl installed (matching cluster K8s version)
- `UPCLOUD_TOKEN` environment variable set
- GitHub repository access for GHCR image push

## Step 1: Provision Infrastructure

```bash
cd deploy/terraform
terraform init
terraform plan
terraform apply
```

This creates:
- UKS cluster (dev plan, free control plane)
- 1x DEV-1xCPU-1GB worker node
- Private network (172.16.1.0/24)
- NGINX Ingress controller + cert-manager (via Helm)
- Kubernetes Secrets (from DB/S3 resource outputs)
- Kubernetes ConfigMaps (app config, mosquitto config)

Preserves existing:
- Managed PostgreSQL (TimescaleDB)
- Managed Object Storage

## Step 2: Get Kubeconfig

```bash
terraform output -raw kubeconfig > ~/.kube/config
chmod 600 ~/.kube/config
kubectl get nodes  # verify connectivity
```

## Step 3: Update DNS

Point `greenhouse.madekivi.fi` to the worker node's public IP:

```bash
terraform output worker_node_ip
# Update DNS A record to this IP
```

## Step 4: Deploy Application

```bash
kubectl apply -f deploy/k8s/
kubectl rollout status deployment/app --timeout=5m
kubectl get pods  # verify all containers running
```

## Step 5: Store Kubeconfig in GitHub Secrets

```bash
# Base64-encode kubeconfig for CI
cat ~/.kube/config | base64 | gh secret set KUBE_CONFIG_DATA
```

After this, pushes to main will auto-deploy via the updated CI/CD pipeline.

## Step 6: Verify

- Visit https://greenhouse.madekivi.fi — should show the playground dashboard
- Authenticate with passkey
- Check Shelly device connectivity (RPC proxy, sensor data)
- Verify MQTT bridge (WebSocket state updates)

## Rollback

If the migration fails, the previous cloud server can be restored by reverting Terraform changes:

```bash
git checkout main -- deploy/terraform/
terraform apply
```

DNS must be pointed back to the old server IP.

## Monitoring

```bash
kubectl logs deployment/app -c app -f          # app logs
kubectl logs deployment/app -c openvpn -f      # VPN logs
kubectl logs deployment/app -c mosquitto -f     # MQTT logs
kubectl top pods                                # resource usage
kubectl describe pod -l app=greenhouse          # pod status/events
```
