# Feature Specification: Migrate to UpCloud Managed Kubernetes

**Feature Branch**: `014-migrate-upcloud-kubernetes`
**Created**: 2026-03-27
**Status**: Draft
**Input**: User description: "reimplement the application infra to run on top of UpCloud Managed Kubernetes. Upcloud docs are mirrored at deploy/upcloud-docs/markdown also do an estimation how the monthly billing will be affected by the change of platform"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Application Runs on Kubernetes (Priority: P1)

As the system operator, I want the greenhouse monitoring application and all supporting services (MQTT broker, reverse proxy, VPN) to run on UpCloud Managed Kubernetes instead of a single Docker Compose server, so that the system benefits from container orchestration, self-healing, and a standardized deployment platform.

**Why this priority**: This is the core migration — without the application running on Kubernetes, no other improvements are possible. The current single-server Docker Compose setup is the baseline that must be replaced.

**Independent Test**: Can be fully tested by deploying the application stack to a Kubernetes cluster and verifying that all services (web UI, MQTT, VPN tunnel, database connectivity) function correctly, passkey authentication works, and the Shelly device communication operates through the VPN tunnel.

**Acceptance Scenarios**:

1. **Given** the Kubernetes cluster is provisioned, **When** workloads are deployed, **Then** the web application is accessible via HTTPS at the configured domain with valid TLS certificates.
2. **Given** the application is running on Kubernetes, **When** a user authenticates with a passkey, **Then** the authentication flow completes successfully and the user can access the dashboard.
3. **Given** the VPN pod is running, **When** the application attempts to communicate with Shelly devices on the home LAN, **Then** RPC proxy requests succeed and sensor data flows through MQTT.
4. **Given** all pods are running, **When** a pod crashes or is terminated, **Then** Kubernetes automatically restarts it within 60 seconds.

---

### User Story 2 - Infrastructure Provisioned via Terraform (Priority: P1)

As the system operator, I want the Kubernetes cluster, node groups, networking, and all supporting UpCloud resources to be provisioned and managed through Terraform, so that the infrastructure remains reproducible, version-controlled, and consistent with the existing infrastructure-as-code approach.

**Why this priority**: Terraform is already the infrastructure management tool for this project. The migration must maintain this practice to avoid manual setup drift and enable safe infrastructure changes.

**Independent Test**: Can be fully tested by running `terraform plan` and `terraform apply` in a clean environment and verifying that all resources (cluster, node groups, managed database, object storage, networking) are created successfully.

**Acceptance Scenarios**:

1. **Given** valid UpCloud credentials and Terraform installed, **When** `terraform apply` is run, **Then** a fully functional Kubernetes cluster with all supporting resources is provisioned.
2. **Given** an existing cluster, **When** a Terraform variable is changed (e.g., node count), **Then** `terraform apply` updates the cluster without destroying unrelated resources.
3. **Given** a provisioned cluster, **When** `terraform destroy` is run, **Then** all managed resources are cleanly removed.

---

### User Story 3 - Continuous Deployment via CI/CD (Priority: P2)

As the system operator, I want the GitHub Actions CD pipeline to build container images and deploy them to the Kubernetes cluster automatically on push to the main branch, replacing the current deployer-container pull model with a direct deployment approach.

**Why this priority**: The current deployer systemd timer model (pull every 5 minutes) is specific to the single-server architecture. Kubernetes enables direct deployment from CI, which is faster, more reliable, and follows standard practices.

**Independent Test**: Can be fully tested by pushing a code change to the main branch and verifying that the new container image is built, pushed to GHCR, and rolled out to the Kubernetes cluster with zero downtime.

**Acceptance Scenarios**:

1. **Given** a push to the main branch, **When** CI tests pass, **Then** the pipeline builds the app image, pushes to GHCR, and triggers a rolling update on the Kubernetes cluster.
2. **Given** a deployment is in progress, **When** the new pods are starting, **Then** the old pods continue serving traffic until new pods pass readiness checks (zero-downtime deployment).
3. **Given** a deployment fails (pods crash-loop), **When** the rollout stalls, **Then** the previous version remains serving traffic and the failure is reported in the CI pipeline.

---

### User Story 4 - Secrets and Configuration Management (Priority: P2)

As the system operator, I want application secrets and configuration to be managed through Kubernetes-native mechanisms (Secrets and ConfigMaps), replacing the current cloud-init plus S3 bootstrap pattern for environment variable delivery.

**Why this priority**: The current system splits config between cloud-init immutable secrets and deployer-image mutable config, merged at deploy time. Kubernetes provides built-in primitives for this that are more maintainable and auditable.

**Independent Test**: Can be fully tested by verifying that all environment variables are correctly injected into pods from Kubernetes Secrets and ConfigMaps, and that updating a ConfigMap triggers a pod restart with new values.

**Acceptance Scenarios**:

1. **Given** secrets are stored in Kubernetes Secrets, **When** a pod starts, **Then** all required environment variables (DATABASE_URL, S3 credentials, SESSION_SECRET) are available to the application.
2. **Given** a configuration value is updated in a ConfigMap, **When** a redeployment is triggered, **Then** the pods receive the updated configuration.
3. **Given** the Terraform provisioning step, **When** database and S3 resources are created, **Then** their connection details are automatically stored as Kubernetes Secrets.

---

### User Story 5 - Monthly Cost Estimation and Comparison (Priority: P2)

As the system operator, I want a clear cost comparison between the current single-server infrastructure and the proposed Kubernetes-based infrastructure, so that I can make an informed decision about the migration based on the expected monthly billing impact.

**Why this priority**: Understanding the financial impact is essential for deciding whether to proceed with the migration. The current setup is very cost-effective, and the operator needs to know exactly how much the new platform will cost.

**Independent Test**: Can be fully tested by reviewing the cost comparison document and verifying that each line item corresponds to an actual UpCloud resource with published pricing.

**Acceptance Scenarios**:

1. **Given** the cost estimation is produced, **When** reviewed, **Then** it includes line-item costs for every UpCloud resource (cluster control plane, worker nodes, load balancer, database, object storage, networking).
2. **Given** the cost estimation, **When** compared to the current infrastructure costs, **Then** the difference is clearly stated with a percentage change.

---

### Edge Cases

- What happens when the VPN pod restarts — does the app pod lose connectivity to Shelly devices, and how is this recovered?
- What happens during a Kubernetes version upgrade — is there downtime for the application?
- What happens if the single worker node (minimal setup) becomes unavailable — how long until recovery?
- How does the MQTT broker handle reconnection from Shelly devices after pod restarts (MQTT clients use persistent sessions)?
- What happens to in-flight WebSocket connections during a rolling deployment?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provision an UpCloud Managed Kubernetes cluster via Terraform, including the control plane and at least one node group.
- **FR-002**: System MUST deploy the application (Node.js server), MQTT broker (Mosquitto), and reverse proxy or ingress controller as Kubernetes workloads.
- **FR-003**: System MUST maintain VPN connectivity to the home LAN Shelly devices via an OpenVPN sidecar container in the same pod as the app (shared network namespace), so that RPC proxy and MQTT bridge continue to function.
- **FR-004**: System MUST expose the web application via HTTPS with valid TLS certificates on the configured domain, using a Kubernetes Ingress controller with NodePort (no managed load balancer).
- **FR-005**: System MUST manage application secrets (DATABASE_URL, S3 credentials, SESSION_SECRET, New Relic license key) via Kubernetes Secrets.
- **FR-006**: System MUST manage non-secret application configuration (PORT, AUTH_ENABLED, DOMAIN, RPID, ORIGIN, MQTT_HOST) via Kubernetes ConfigMaps.
- **FR-007**: System MUST preserve the existing Managed PostgreSQL (TimescaleDB) and Managed Object Storage resources, connecting to them from the Kubernetes cluster over private networking.
- **FR-008**: System MUST implement a CI/CD pipeline that builds container images and deploys to Kubernetes on push to the main branch, with zero-downtime rolling updates.
- **FR-009**: System MUST maintain existing security posture: non-root containers, read-only root filesystems, passkey authentication, and network policies restricting access.
- **FR-010**: System MUST include a documented cost comparison between the current infrastructure and the Kubernetes-based infrastructure, with line-item monthly estimates for each UpCloud resource.
- **FR-011**: System MUST support the existing observability stack (New Relic via OpenTelemetry) on the Kubernetes platform.
- **FR-012**: System MUST ensure that Shelly script deployment remains functional from the CI/CD pipeline or from within the cluster.

### Key Entities

- **Kubernetes Cluster**: The UpCloud Managed Kubernetes (UKS) control plane and configuration (version, plan, network CIDRs, API access controls).
- **Node Group**: A set of worker nodes with a specific Cloud Server plan, count, and scaling configuration.
- **Workload**: A deployable unit (Deployment, StatefulSet, or DaemonSet) representing one of the application services (app, MQTT, VPN, monitoring).
- **Service/Ingress**: Kubernetes networking resources that expose workloads internally (ClusterIP) or externally (LoadBalancer/Ingress).
- **Secret/ConfigMap**: Kubernetes configuration resources holding sensitive and non-sensitive application configuration respectively.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All application functionality (dashboard, authentication, Shelly device communication, sensor history) works identically on the Kubernetes platform as on the current single-server platform.
- **SC-002**: Application recovers automatically from a pod failure within 60 seconds without operator intervention.
- **SC-003**: Deployments complete with zero downtime — no failed requests during a rolling update.
- **SC-004**: The entire infrastructure (cluster, networking, database, storage) can be provisioned from scratch via Terraform in under 15 minutes.
- **SC-005**: A code push to the main branch results in the new version running in the cluster within 10 minutes.
- **SC-006**: Monthly cost estimation is documented with line-item accuracy, enabling the operator to compare current vs. Kubernetes spending.
- **SC-007**: All existing security controls (passkey auth, non-root containers, read-only filesystems, network isolation) are preserved or improved on the Kubernetes platform.

## Cost Estimation

### Current Infrastructure (Monthly)

| Resource               | Plan                  | Est. Cost (EUR) |
| ---------------------- | --------------------- | --------------- |
| Cloud Server           | DEV-1xCPU-1GB-10GB    | 3-5             |
| Managed PostgreSQL     | 1x1xCPU-1GB-10GB      | 10-15           |
| Managed Object Storage | 250 GB minimum        | 2-5             |
| **Total**              |                       | **15-25**       |

### Kubernetes Infrastructure — Minimal Cost (Monthly)

| Resource               | Plan / Config                          | Est. Cost (EUR) |
| ---------------------- | -------------------------------------- | --------------- |
| UKS Control Plane      | Development (free, up to 30 nodes)     | 0               |
| Worker Node             | 1x General Purpose 2xCPU-2GB          | 15              |
| Managed PostgreSQL     | 1x1xCPU-1GB-10GB (unchanged)           | 10-15           |
| Managed Object Storage | 250 GB minimum (unchanged)             | 2-5             |
| **Total**              |                                        | **27-35**       |

Note: No managed load balancer — HTTPS is handled by an Ingress controller exposed via NodePort on the worker node's public IP. No NAT gateway — worker node has a public IP.

### Cost Impact Summary

- **Kubernetes setup**: ~1.5-2x increase over current costs (EUR 27-35 vs EUR 15-25/month). The free development control plane, a single worker node, and no load balancer keep costs close to the current baseline.
- **Primary cost driver**: The worker node (EUR 15/month) replaces the current DEV server (EUR 3-5/month). The 2xCPU-2GB General Purpose plan provides enough resources to run all workloads on a single node.
- **No HA required**: High availability is explicitly out of scope. Single worker node, single database node, development control plane.

## Clarifications

### Session 2026-03-27

- Q: How should the app reach Shelly devices through the VPN in Kubernetes (replacing Docker's network_mode sharing)? → A: Sidecar — OpenVPN runs as a second container in the same pod as the app, sharing the network namespace.
- Q: How should HTTPS/TLS termination work to minimize cost? → A: Ingress controller (Cilium Gateway or NGINX Ingress) with NodePort on the worker node's public IP. No managed load balancer.

## Assumptions

- The UpCloud Managed Kubernetes development plan (free control plane, up to 30 nodes) is sufficient for the initial migration. The production plan can be adopted later if HA is needed.
- The existing Managed PostgreSQL and Object Storage resources will be reused without changes — only the client connectivity path changes (from cloud server to Kubernetes pods via private network).
- The VPN connectivity to Shelly devices will be maintained by running OpenVPN as a sidecar container in the app pod (shared network namespace, NET_ADMIN capability, /dev/net/tun access), mirroring the current Docker Compose `network_mode: "service:openvpn"` pattern.
- The Caddy reverse proxy is replaced by a Kubernetes Ingress controller (Cilium Gateway or NGINX Ingress) with cert-manager for Let's Encrypt TLS, exposed via NodePort on the worker node's public IP. No managed load balancer is used.
- Shelly script deployment from CI will be handled by a Kubernetes Job that runs during the CD pipeline, replacing the deployer's VPN-based deployment step.
- Cost estimates are based on UpCloud's published pricing as of March 2026. Actual costs may vary based on usage patterns and pricing changes.
- The MQTT broker (Mosquitto) does not require persistent storage — it operates as a stateless message relay with volatile tmpfs storage, matching the current configuration.
