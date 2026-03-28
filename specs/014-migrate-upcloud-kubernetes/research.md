# Research: Migrate to UpCloud Managed Kubernetes

## Decision 1: Kubernetes Cluster Configuration

**Decision**: Use UKS development plan (free control plane) with a single DEV-1xCPU-1GB worker node in fi-hel1 zone.

**Rationale**: The development plan supports up to 30 worker nodes and is free. The DEV-1xCPU-1GB node matches the current server plan cost (~EUR 3-5/month). Single-user hobby project does not need HA or production-grade control plane.

**Alternatives considered**:
- Production control plane (~EUR 50-150/month) — rejected, no HA requirement
- General Purpose 2xCPU-2GB node (~EUR 15/month) — fallback if 1GB RAM is insufficient with K8s overhead

**Risk**: Kubernetes system components (kubelet, Cilium CNI, CoreDNS) consume ~300-500MB RAM, leaving ~500-700MB for app workloads. Current app uses ~128MB. Tight but likely viable. If pods are evicted due to memory pressure, upgrade node plan.

## Decision 2: Network Architecture

**Decision**: Public node group (worker node gets a public IP) with a dedicated private network for the cluster. No NAT gateway, no managed load balancer.

**Rationale**: Public nodes are the simplest and cheapest option. The worker node's public IP serves as the ingress point. A private network is required by UKS but carries no additional cost.

**Alternatives considered**:
- Private node groups + NAT gateway — rejected, adds EUR 20-30/month for no benefit on a single-node cluster
- Managed Load Balancer — rejected, adds EUR 10-20/month; NodePort/hostNetwork suffices for single-node

**Network CIDR**: `172.16.1.0/24` for the K8s private network. Does not overlap with reserved K8s CIDRs (pod: `192.168.0.0/16`, service: `10.128.0.0/12`, control plane: `172.31.240.0/24`).

## Decision 3: TLS Termination

**Decision**: NGINX Ingress controller deployed as a DaemonSet with `hostNetwork: true`, binding directly to ports 80 and 443 on the worker node's public IP. cert-manager with HTTP-01 challenge for Let's Encrypt certificates.

**Rationale**: hostNetwork mode allows the ingress controller to listen on standard ports (80/443) without NodePort high-port mapping (30000-32767). This means DNS points directly to the node IP, and HTTPS works on the standard port. cert-manager HTTP-01 challenge works because port 80 is publicly accessible.

**Alternatives considered**:
- Caddy pod with NodePort — rejected, requires non-standard ports (e.g., 30443) unless using hostNetwork
- Cilium Gateway API — viable on k1.32+ but auto-provisions a managed load balancer (adds cost)
- DNS-01 challenge — rejected, requires DNS provider API integration; HTTP-01 is simpler

## Decision 4: Pod Architecture

**Decision**: Single Deployment with 3 containers in one pod: app (Node.js), openvpn (sidecar), mosquitto (sidecar). All containers share the network namespace automatically.

**Rationale**: This mirrors the current Docker Compose architecture where all services share the OpenVPN network namespace. In Kubernetes, containers in the same pod automatically share the network namespace. The app reaches Mosquitto on `localhost:1883` and has VPN tunnel access through the OpenVPN sidecar — identical to the current `network_mode: "service:openvpn"` pattern.

**Alternatives considered**:
- Separate pods for each service — rejected, would require explicit service routing and loses the shared-network simplicity
- OpenVPN as a separate StatefulSet with pod affinity — rejected, adds complexity without benefit for single-node

**Special requirements**:
- OpenVPN sidecar needs `NET_ADMIN` capability (not full privileged mode)
- OpenVPN sidecar needs hostPath volume for `/dev/net/tun` (CharDevice type)
- App container: read-only root filesystem, non-root user (1000), tmpfs on /tmp
- Mosquitto container: read-only root filesystem, non-root user (1883), tmpfs for data

## Decision 5: Secrets Management

**Decision**: Terraform creates Kubernetes Secrets directly using the `kubernetes_secret` resource, populated from Terraform resource outputs (DATABASE_URL, S3 credentials) and variables (SESSION_SECRET). S3 Object Storage remains the durable backing store for VPN config and database URL.

**Rationale**: Terraform already provisions the database and S3 resources. Using the Kubernetes provider to create Secrets from those outputs is a natural extension. This eliminates the cloud-init `.env.secrets` file and the deployer's S3-fetch-and-merge pattern entirely.

**Alternatives considered**:
- ExternalSecrets Operator syncing from S3 — rejected, adds operational complexity for a single-secret-set system
- Init containers fetching from S3 at pod start — rejected, adds startup latency and failure modes
- Manual kubectl create secret — rejected, not reproducible

**Secret contents**:
- `app-secrets`: DATABASE_URL, SESSION_SECRET, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, NEW_RELIC_LICENSE_KEY
- `openvpn-config`: VPN configuration file (fetched from S3 by Terraform via local-exec)

## Decision 6: CI/CD Pipeline

**Decision**: GitHub Actions builds container images (app + openvpn), pushes to GHCR, then applies Kubernetes manifests via `kubectl set image` for rolling updates. Kubeconfig stored as a GitHub Actions secret (base64-encoded).

**Rationale**: `kubectl set image` triggers a rolling update without needing to re-apply full manifests. The kubeconfig is exported from Terraform outputs and stored once in GitHub Secrets. This replaces the deployer container pull model entirely.

**Alternatives considered**:
- Helm chart — rejected, overkill for a fixed set of 3 manifests
- ArgoCD/Flux GitOps — rejected, adds operational overhead; push-based deployment is simpler
- kustomize with image transformer — viable, slightly more structured than `kubectl set image`

**Pipeline flow**:
1. Test (npm test)
2. Build app image + openvpn image → push to GHCR
3. `kubectl set image deployment/app app=ghcr.io/wnt/greenhouse-solar-heater:$SHA`
4. `kubectl rollout status deployment/app --timeout=5m`

## Decision 7: Terraform Resource Changes

**Decision**: Modify `deploy/terraform/main.tf` in-place. Remove: `upcloud_server`, `upcloud_server_group`, `upcloud_firewall_rules`. Add: `upcloud_network`, `upcloud_kubernetes_cluster`, `upcloud_kubernetes_node_group`. Keep: `upcloud_managed_object_storage`, `upcloud_managed_database_postgresql`. Add providers: `kubernetes`, `helm`.

**Rationale**: The existing Terraform configuration is well-structured and can be evolved. The cloud server and its associated resources (firewall, cloud-init) are replaced by the K8s cluster. Object storage and database are reused with only connectivity changes.

**Migration concern**: Running `terraform apply` with these changes will destroy the existing cloud server and create the K8s cluster. A brief downtime window is expected during the cutover. DNS must be updated to point to the new worker node's public IP.

## Decision 8: Removing the Deployer

**Decision**: Delete the entire `deploy/deployer/` directory. Move configuration values from `config.env` to a Kubernetes ConfigMap manifest in `deploy/k8s/configmap.yaml`.

**Rationale**: The deployer container exists solely to pull config + compose files and run `docker compose up`. Kubernetes replaces this with native deployment mechanisms. The deployer's responsibilities are redistributed:
- Config merging → Kubernetes ConfigMap + Secret
- Image pulling → Kubernetes imagePullPolicy
- Service orchestration → Kubernetes Deployment + probes
- VPN config fetch → Terraform local-exec + Kubernetes Secret
- Shelly script deploy → CI/CD job step (kubectl exec or dedicated Job)

## Decision 9: Ingress Controller Installation

**Decision**: Install NGINX Ingress controller and cert-manager via Helm releases managed by Terraform (using the `helm_release` resource). This ensures the ingress infrastructure is provisioned alongside the cluster.

**Rationale**: Terraform's Helm provider allows declarative management of in-cluster components. NGINX Ingress is configured with `hostNetwork: true` and deployed as a DaemonSet (1 replica on the single node). cert-manager is installed with default settings and a ClusterIssuer for Let's Encrypt HTTP-01.

**Alternatives considered**:
- kubectl apply from CI — rejected, ingress infra should exist before first app deployment
- Manual helm install — rejected, not reproducible
