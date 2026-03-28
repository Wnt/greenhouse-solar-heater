# Tasks: Migrate to UpCloud Managed Kubernetes

**Input**: Design documents from `/specs/014-migrate-upcloud-kubernetes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: No test tasks generated (not requested in feature specification). Existing `npm test` suite is unchanged.

**Organization**: Tasks grouped by user story. US2 (Terraform) and US4 (Secrets) are foundational — they must complete before US1 (App on K8s) can begin.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Create directory structure and prepare manifest templates

- [x] T001 Create Kubernetes manifests directory at `deploy/k8s/`
- [x] T002 [P] Create `deploy/k8s/kustomization.yaml` listing all manifest files for kustomize base
- [x] T003 [P] Read current Terraform config at `deploy/terraform/main.tf`, `deploy/terraform/variables.tf`, `deploy/terraform/outputs.tf` to understand existing resource definitions

---

## Phase 2: Foundational — Terraform & Secrets (US2 + US4)

**Purpose**: Provision the UKS cluster, networking, and secrets via Terraform. MUST complete before any K8s workloads can be deployed.

**Goal (US2)**: All UpCloud infrastructure (cluster, node group, private network) provisioned via `terraform apply`
**Goal (US4)**: All secrets and config delivered to the cluster as K8s Secrets and ConfigMaps via Terraform

**Independent Test**: Run `terraform plan` and verify all resources are planned correctly. After `terraform apply`, run `kubectl get nodes` to confirm cluster connectivity.

### Terraform Infrastructure (US2)

- [x] T004 [US2] Add `upcloud_network` resource for K8s private network (172.16.1.0/24, fi-hel1, DHCP enabled) in `deploy/terraform/main.tf`
- [x] T005 [US2] Add `upcloud_kubernetes_cluster` resource (development plan, fi-hel1 zone, references private network, control_plane_ip_filter for API access) in `deploy/terraform/main.tf`
- [x] T006 [US2] Add `upcloud_kubernetes_node_group` resource (1x DEV-1xCPU-1GB, node_count=1, references cluster) in `deploy/terraform/main.tf`
- [x] T007 [US2] Add `kubernetes` and `helm` provider blocks configured from cluster outputs (host, client_certificate, client_key, cluster_ca_certificate) in `deploy/terraform/main.tf`
- [x] T008 [US2] Add `helm_release` for ingress-nginx (hostNetwork: true, DaemonSet, controller.service.type=ClusterIP) in `deploy/terraform/main.tf`
- [x] T009 [US2] Add `helm_release` for cert-manager (installCRDs: true) and `kubernetes_manifest` for ClusterIssuer (letsencrypt-prod, HTTP-01 solver, nginx ingress class) in `deploy/terraform/main.tf`
- [x] T010 [US2] Remove `upcloud_server`, `upcloud_server_group`, and `upcloud_firewall_rules` resources from `deploy/terraform/main.tf`. Remove `cloud-init.yaml` template reference.
- [x] T011 [US2] Update `deploy/terraform/variables.tf`: remove server-related variables (ssh_allow_ip, enable_vpn), add K8s variables (k8s_version, node_plan, node_count, control_plane_ip_filter)
- [x] T012 [US2] Update `deploy/terraform/outputs.tf`: remove server IP output, add kubeconfig output (sensitive), worker node public IP output
- [x] T013 [US2] Delete `deploy/terraform/cloud-init.yaml` (no longer needed — K8s replaces cloud-init bootstrap)

### Kubernetes Secrets & ConfigMaps (US4)

- [x] T014 [US4] Add `kubernetes_secret` resource for `app-secrets` (DATABASE_URL from DB resource output, SESSION_SECRET from variable, S3 credentials from object storage outputs, NEW_RELIC_LICENSE_KEY from variable) in `deploy/terraform/main.tf`
- [x] T015 [US4] Add `kubernetes_secret` resource for `openvpn-config` (VPN config file fetched from S3 via `local_file` data source or local-exec provisioner) in `deploy/terraform/main.tf`
- [x] T016 [US4] Add `kubernetes_config_map` resource for `app-config` (PORT, AUTH_ENABLED, DOMAIN, RPID, ORIGIN, MQTT_HOST=localhost, VPN_CHECK_HOST, CONTROLLER_IP, OTEL_SERVICE_NAME, GITHUB_REPO — values from current `deploy/deployer/config.env`) in `deploy/terraform/main.tf`
- [x] T017 [US4] Add `kubernetes_config_map` resource for `mosquitto-config` (listener 1883 0.0.0.0, allow_anonymous true) in `deploy/terraform/main.tf`
- [x] T018 [US2] Run `terraform validate` to verify all resource definitions are syntactically correct

**Checkpoint**: `terraform apply` provisions the cluster, node, ingress controller, cert-manager, secrets, and configmaps. `kubectl get nodes` shows the worker node ready. `kubectl get secrets` shows app-secrets and openvpn-config.

---

## Phase 3: User Story 1 — Application Runs on Kubernetes (Priority: P1)

**Goal**: All application services (app + openvpn + mosquitto) run as a single pod on the K8s cluster, accessible via HTTPS with passkey auth and Shelly device connectivity.

**Independent Test**: Deploy manifests, visit https://greenhouse.madekivi.fi, authenticate with passkey, verify Shelly device communication and sensor data flow.

### Implementation for User Story 1

- [x] T019 [P] [US1] Create `deploy/k8s/app-deployment.yaml`: Deployment with 1 replica, 3 containers (app, openvpn sidecar, mosquitto sidecar). App container: image ghcr.io/wnt/greenhouse-solar-heater:latest, port 3000, envFrom app-config ConfigMap + app-secrets Secret, readOnlyRootFilesystem, runAsUser 1000, tmpfs /tmp 64Mi, liveness/readiness probes on /health. OpenVPN sidecar: image ghcr.io/wnt/greenhouse-solar-heater-openvpn:latest, NET_ADMIN capability, hostPath /dev/net/tun CharDevice, Secret openvpn-config mounted at /etc/openvpn. Mosquitto sidecar: image eclipse-mosquitto:2-openssl, port 1883, ConfigMap mosquitto-config, readOnlyRootFilesystem, runAsUser 1883, emptyDir for data. Rolling update strategy: maxSurge 1, maxUnavailable 0.
- [x] T020 [P] [US1] Create `deploy/k8s/services.yaml`: ClusterIP Service named `app` on port 3000, selector app=greenhouse
- [x] T021 [P] [US1] Create `deploy/k8s/ingress.yaml`: Ingress resource for greenhouse.madekivi.fi, ingressClassName nginx, TLS with cert-manager annotation (cert-manager.io/cluster-issuer: letsencrypt-prod), secretName app-tls, backend service app port 3000
- [x] T022 [US1] Update `deploy/k8s/kustomization.yaml` to list all manifest files (app-deployment.yaml, services.yaml, ingress.yaml)
- [x] T023 [US1] Verify `deploy/docker/Dockerfile` does not need changes for K8s (confirm EXPOSE 3000, non-root user, health endpoint compatibility)
- [x] T024 [US1] Verify `deploy/openvpn/Dockerfile` does not need changes for K8s (confirm /dev/net/tun support, NET_ADMIN compatibility, config file path matches Secret mount)

**Checkpoint**: `kubectl apply -k deploy/k8s/` deploys the app pod. All 3 containers start, HTTPS works on the domain, passkey auth succeeds, Shelly device communication works through VPN tunnel.

---

## Phase 4: User Story 3 — Continuous Deployment via CI/CD (Priority: P2)

**Goal**: GitHub Actions CD pipeline builds images, pushes to GHCR, and deploys to K8s automatically on push to main.

**Independent Test**: Push a commit to main, verify the pipeline builds images, pushes to GHCR, and triggers a rolling update. Verify the new version is running.

### Implementation for User Story 3

- [x] T025 [US3] Update `.github/workflows/deploy.yml`: Remove deployer image build job entirely. Keep test job and app image build job. Keep openvpn image build job (or add if missing). Add deploy job after build: install kubectl, decode KUBE_CONFIG_DATA secret to ~/.kube/config, run `kubectl set image deployment/app app=ghcr.io/wnt/greenhouse-solar-heater:$SHA openvpn=ghcr.io/wnt/greenhouse-solar-heater-openvpn:$SHA`, run `kubectl rollout status deployment/app --timeout=5m`.
- [x] T026 [US3] Add `KUBE_CONFIG_DATA` to GitHub Actions secrets documentation (base64-encoded kubeconfig from `terraform output -raw kubeconfig | base64`). Note in deploy workflow comments how to refresh this secret.
- [x] T027 [US3] Verify rolling update works: deployment strategy maxSurge=1, maxUnavailable=0 ensures zero-downtime. Old pod continues serving until new pod passes readiness check.

**Checkpoint**: Push to main triggers build → push → deploy → rolling update. `kubectl rollout history deployment/app` shows the new revision.

---

## Phase 5: User Story 5 — Cost Estimation (Priority: P2)

**Goal**: Documented cost comparison with line-item accuracy.

**Independent Test**: Review the cost comparison in the spec and verify each line item against UpCloud pricing.

### Implementation for User Story 5

- [x] T028 [US5] Verify cost estimates in `specs/014-migrate-upcloud-kubernetes/spec.md` against actual UpCloud pricing page. Update the Cost Estimation section with verified prices (DEV-1xCPU-1GB node, free dev control plane, existing DB and object storage costs). Include percentage change from current infrastructure.

**Checkpoint**: Cost estimation is accurate and includes line-item costs with source references.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Clean up old deployment artifacts, update documentation

- [x] T029 [P] Delete `deploy/deployer/` directory entirely (Dockerfile, deploy.sh, docker-compose.yml, Caddyfile, config.env) — replaced by K8s manifests and Terraform
- [x] T030 [P] Delete `deploy/terraform/cloud-init.yaml` if not already removed in T013
- [x] T031 Update `CLAUDE.md`: update Cloud Deployment Architecture section to reflect Kubernetes (replace Docker Compose description with K8s architecture), update Environment Variable Split section (replace cloud-init/deployer with K8s Secrets/ConfigMaps), update CI/CD workflow descriptions, add `deploy/k8s/` to File Relationships, remove deployer references
- [x] T032 Update `specs/014-migrate-upcloud-kubernetes/spec.md` status from Draft to Complete
- [x] T033 Run `terraform validate` and `kubectl diff -k deploy/k8s/` to verify all manifests are valid
- [x] T034 Run existing test suite (`npm test`) to confirm no regressions from infrastructure changes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories. Must `terraform apply` successfully.
- **US1 (Phase 3)**: Depends on Phase 2 (cluster, secrets, ingress must exist)
- **US3 (Phase 4)**: Depends on US1 (must have working deployment to update)
- **US5 (Phase 5)**: No code dependencies — can run in parallel with any phase
- **Polish (Phase 6)**: Depends on US1 and US3 being complete

### User Story Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (US2 + US4: Terraform + Secrets) ← BLOCKS ALL
    ↓
Phase 3 (US1: App on K8s) ←→ Phase 5 (US5: Cost estimation, parallel)
    ↓
Phase 4 (US3: CI/CD pipeline)
    ↓
Phase 6 (Polish)
```

### Within Each Phase

- Tasks marked [P] can run in parallel
- Terraform resources should be added incrementally (T004-T009 can be batched, then T010-T013, then T014-T017)
- K8s manifests (T019-T021) can all be written in parallel

### Parallel Opportunities

- T002, T003 can run in parallel during Setup
- T019, T020, T021 can all be written in parallel (different files, no dependencies)
- T029, T030 can run in parallel during Polish
- US5 (T028) can run anytime — no code dependencies

---

## Parallel Example: Phase 3 (US1)

```bash
# Launch all K8s manifest tasks together:
Task: "Create deploy/k8s/app-deployment.yaml"
Task: "Create deploy/k8s/services.yaml"
Task: "Create deploy/k8s/ingress.yaml"
```

---

## Implementation Strategy

### MVP First (US2 + US4 + US1)

1. Complete Phase 1: Setup (directory structure)
2. Complete Phase 2: Terraform provisions cluster, secrets, ingress
3. Complete Phase 3: App deployed and verified on K8s
4. **STOP and VALIDATE**: Visit HTTPS domain, test passkey auth, verify Shelly connectivity
5. This is the MVP — app runs on Kubernetes

### Incremental Delivery

1. Setup + Foundational → Cluster running, `kubectl get nodes` works
2. Add US1 → App accessible on HTTPS → **MVP deployed**
3. Add US3 → Automated deployments on push to main
4. Add US5 → Cost estimation verified
5. Polish → Clean up deployer, update docs

### Migration Cutover

The migration involves a brief downtime window:
1. `terraform apply` destroys old cloud server, creates K8s cluster
2. Deploy app manifests to cluster
3. Update DNS to point to worker node's public IP
4. Verify HTTPS and app functionality

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US2 and US4 are merged into Phase 2 because they're both Terraform work and tightly coupled
- The deployer directory is removed in Polish, not earlier, to preserve rollback capability during migration
- Existing test suite (`npm test`) is unchanged — no app code is modified
- Commit after each task or logical group
