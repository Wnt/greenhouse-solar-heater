# Data Model: Kubernetes Resource Model

This document describes the Kubernetes resources that compose the deployed system. No application-level data model changes are required — the app, database schema, and S3 objects remain identical.

## Terraform-Managed Resources

### UpCloud Resources

| Resource | Terraform Type | Purpose |
|----------|---------------|---------|
| Private Network | `upcloud_network` | Required network for UKS cluster (172.16.1.0/24) |
| K8s Cluster | `upcloud_kubernetes_cluster` | UKS development plan, fi-hel1 zone |
| Node Group | `upcloud_kubernetes_node_group` | 1x DEV-1xCPU-1GB worker node |
| PostgreSQL | `upcloud_managed_database_postgresql` | Unchanged (1x1xCPU-1GB-10GB) |
| Object Storage | `upcloud_managed_object_storage` | Unchanged (credentials, VPN config) |

### Kubernetes Resources (via Terraform providers)

| Resource | K8s Type | Purpose |
|----------|----------|---------|
| app-secrets | `kubernetes_secret` | DATABASE_URL, SESSION_SECRET, S3 creds, NR key |
| openvpn-config | `kubernetes_secret` | VPN configuration file |
| app-config | `kubernetes_config_map` | Non-secret env vars (PORT, AUTH_ENABLED, DOMAIN, etc.) |
| mosquitto-config | `kubernetes_config_map` | Mosquitto listener configuration |

### Helm Releases (via Terraform)

| Release | Chart | Purpose |
|---------|-------|---------|
| ingress-nginx | ingress-nginx/ingress-nginx | NGINX Ingress controller (hostNetwork, DaemonSet) |
| cert-manager | jetstack/cert-manager | TLS certificate automation (Let's Encrypt HTTP-01) |

## Kubernetes Manifest Resources

### Deployment: `app`

Single-replica Deployment with 3 containers sharing the network namespace.

**Container: app**
- Image: `ghcr.io/wnt/greenhouse-solar-heater:latest`
- Port: 3000
- Security: runAsUser 1000, readOnlyRootFilesystem, non-root
- Volumes: tmpfs on /tmp (64Mi)
- Probes: HTTP GET /health (liveness: 30s, readiness: 10s)
- Env: from ConfigMap `app-config` + Secret `app-secrets`

**Container: openvpn (sidecar)**
- Image: `ghcr.io/wnt/greenhouse-solar-heater-openvpn:latest`
- Security: NET_ADMIN capability (not privileged)
- Volumes: hostPath /dev/net/tun (CharDevice), Secret `openvpn-config`
- Probes: exec `pgrep openvpn` (liveness: 30s)

**Container: mosquitto (sidecar)**
- Image: `eclipse-mosquitto:2-openssl`
- Port: 1883 (accessible to app on localhost)
- Security: runAsUser 1883, readOnlyRootFilesystem, non-root
- Volumes: ConfigMap `mosquitto-config`, emptyDir for data (64Mi)
- Probes: exec `mosquitto_pub -t healthcheck -n` (liveness: 30s)

**Rolling Update Strategy**:
- maxSurge: 1 (brief period with 2 pods during update)
- maxUnavailable: 0 (zero-downtime)

### Service: `app`

- Type: ClusterIP
- Port: 3000 → target 3000
- Selector: app=greenhouse

### Ingress: `app`

- Class: nginx
- Host: greenhouse.madekivi.fi
- TLS: cert-manager annotation (letsencrypt-prod issuer)
- Backend: Service `app` port 3000

### ClusterIssuer: `letsencrypt-prod`

- ACME server: https://acme-v02.api.letsencrypt.org/directory
- Solver: HTTP-01 via nginx ingress class

## Resource Relationships

```
Internet → Worker Node :80/:443 (hostNetwork)
  → NGINX Ingress Controller
    → Ingress rule (greenhouse.madekivi.fi)
      → Service: app (ClusterIP :3000)
        → Pod: app
          ├── Container: app (:3000)
          │   ├── env ← ConfigMap: app-config
          │   ├── env ← Secret: app-secrets
          │   └── connects to PostgreSQL (private network)
          ├── Container: openvpn (VPN tunnel)
          │   ├── config ← Secret: openvpn-config
          │   └── /dev/net/tun ← hostPath
          └── Container: mosquitto (:1883)
              └── config ← ConfigMap: mosquitto-config

cert-manager → ClusterIssuer → Certificate → TLS Secret → Ingress
```

## State and Lifecycle

- **Pod restart**: All 3 containers restart together. OpenVPN re-establishes tunnel, Mosquitto restarts (Shelly devices reconnect automatically), app reconnects to MQTT and DB.
- **Rolling update**: New pod starts with all 3 containers. Once readiness probe passes (/health on :3000), old pod terminates.
- **Cluster destroy/recreate**: Terraform re-provisions all K8s Secrets from resource outputs. Helm releases reinstall ingress and cert-manager. App manifests re-applied from CI.
