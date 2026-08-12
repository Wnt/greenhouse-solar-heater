# Deployment

The workload runs **on-prem** on a single-node **k3s** cluster (a VM on the
Proxmox host `pve-nvme`), fronted by a small public edge box. It moved off
UpCloud Managed Kubernetes on **2026-08-02**; the OpenVPN tunnel that used to
carry Shelly traffic is **gone** — the k3s node sits on the device VLAN.

## Architecture

```
                    DNS: greenhouse.madekivi.fi  A → edge box (public IP)
                                 │
Internet ──:443/:80──▶ edge box: HAProxy
                       ├─ SNI pass-through for greenhouse hosts ──┐
                       └─ everything else → Caddy (lab.* sites)   │
                                                                  │ WireGuard
                                                                  │ (home dials out,
                                                                  │  keepalive 25 s)
                                                                  ▼
                       k3s VM (on-prem, no inbound ports at home)
                         ├─ vNIC1  LAN 192.168.1.x — mgmt + WireGuard client
                         │         ingress-nginx (hostNetwork DaemonSet) :80/:443
                         │         cert-manager + letsencrypt-prod (HTTP-01)
                         ├─ vNIC2  VLAN 30 — Shelly 192.168.30.50–.55, reached natively
                         ├─ app Deployment: app (:3000) + mosquitto sidecar
                         │         mosquitto hostPort 1883 bound to 192.168.30.5
                         ├─ watcher Deployment
                         ├─ CloudNativePG + TimescaleDB (greenhouse-db-*)
                         └─ k8s-api-proxy Ingress → kubernetes.default.svc (CI kubectl)

S3 = Garage LXC (path-style SigV4) — server/lib/s3-client.js works unchanged.
```

TLS terminates **in-cluster**: the edge does SNI pass-through, so certificate
keys never leave home. HTTP-01 challenges work because the edge forwards :80.

## How devices are reached (no VPN)

- The k3s node has a **VLAN-30 interface**, so `192.168.30.50–.55` are directly
  reachable from pods — sensor discovery, sensor apply and the `script-monitor`
  poll are plain HTTP on the LAN.
- The Shelly devices publish MQTT to **`192.168.30.5:1883`**, the mosquitto
  sidecar's `hostPort` on the node's VLAN-30 address. Same subnet, layer-2 — no
  firewall rule and no tunnel involved. The app container reaches the same
  broker on `localhost:1883` (`MQTT_HOST=localhost`).
- `shelly/deploy.sh` provisions that broker address (`MQTT_BROKER_HOST`, set by
  the CD workflow) and treats it as part of the desired state, so a device left
  pointing at the retired VPN broker gets corrected on the next deploy.

Because the mosquitto `hostPort` can only be bound by one pod at a time, the
`app` Deployment keeps `strategy: Recreate` (brief downtime per deploy).

## Deploy flow

```
push to main → GitHub Actions (.github/workflows/deploy.yml)
  → test + build app image → GHCR
  → preflight: relay topic-map coverage (throwaway Job on the new image)
  → kubectl set image deployment/app (+ watcher)
  → rollout status
  → gate on Shelly RPC reachability
  → kubectl exec → shelly/deploy.sh  (control script + MQTT/eth provisioning)
```

CI reaches the cluster through `https://k8s.greenhouse.madekivi.fi` (edge → WG →
`k8s-api-proxy` Ingress), authenticating with the `KUBE_CONFIG_DATA` secret — a
scoped deployer ServiceAccount (`deploy/k8s/deployer-rbac.yaml`) that can patch
the `app`/`watcher` Deployments and exec into pods, nothing more.

Manifests live in `deploy/k8s/` and are applied with kustomize:

```bash
kubectl apply -k deploy/k8s/
```

`deploy/k8s/preview/` holds the PR-preview templates (see the root CLAUDE.md).

## Config delivery

- `app-config` ConfigMap — PORT, AUTH_ENABLED, RPID, ORIGIN, DOMAIN,
  MQTT_HOST, SENSOR_HOST_IPS, RELAY_TOPIC_MAP, OTEL_*.
- `app-secrets` Secret — DATABASE_URL (CNPG), SESSION_SECRET, S3_* (Garage),
  NEW_RELIC_LICENSE_KEY.

Both are cluster objects now, **not** Terraform-managed. Edit them with
`kubectl edit configmap/app-config` / `kubectl edit secret/app-secrets` (or
apply from your own private manifests) and restart the Deployment.

## `deploy/terraform/` is retired

It describes the destroyed-to-be UpCloud stack (UKS cluster, Managed
PostgreSQL, Object Storage) and is **not** the source of truth for anything
running today. It is kept only while the old cluster remains as a rollback
path. Do not `terraform apply` it, and do not read prod config values out of
it.

## Node-level firewalling

Handled outside the cluster: the edge box's nftables/UpCloud firewall for public
ports, and the UDM Pro for LAN/VLAN policy. The old in-cluster `node-firewall`
DaemonSet (which existed to protect a public UpCloud worker) was removed with
the migration — applying it to the home node would have filtered LAN services.

## Operating notes

```bash
kubectl get pods                                  # app, watcher, greenhouse-db-*
kubectl logs deployment/app -c app --tail=100
kubectl exec deployment/app -c app -- sh -c 'curl -s http://192.168.30.50/rpc/Shelly.GetStatus'
kubectl exec greenhouse-db-1 -c postgres -- psql -d greenhouse -c '\dt'
```

Migration record, credentials and the restore runbook live **outside this repo**
in the private `upcloud_migrate` working copy (`MIGRATION-PLAN.md`,
`DISASTER-RECOVERY.md`).
