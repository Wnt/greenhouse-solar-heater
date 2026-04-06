# Tasks: CD Pipeline Shelly Script Deployment

**Feature**: 018-cd-shelly-deploy
**Created**: 2026-04-07
**Source**: [plan.md](plan.md)

## Phase 1: RBAC Update

**Goal**: Grant the deployer ServiceAccount permission to exec into pods.

- [x] T001 [P] Add `pods/exec` subresource permission to the deployer Role in `deploy/terraform/main.tf`. The pods rule currently has verbs `["get", "list", "watch"]` — add a new rule for `pods/exec` with verb `["create"]`.

## Phase 2: CD Pipeline

**Goal**: Add a shelly-deploy job to the GitHub Actions deploy workflow.

- [x] T002 Add a `shelly-deploy` job in `.github/workflows/deploy.yml` that depends on the `deploy` job. The job should: configure kubeconfig from `KUBE_CONFIG_DATA` secret, wait for VPN connectivity by polling the Shelly device from inside the pod (up to 60s), then run `kubectl exec deployment/app -c app -- sh -c 'cd /app/shelly && DEPLOY_VIA_VPN=true bash deploy.sh'`. Use `continue-on-error: true` on the exec step so Shelly deploy failure does not fail the pipeline.

## Phase 3: Documentation

**Goal**: Update CLAUDE.md to reflect the new CD pipeline step.

- [x] T003 [P] Update CLAUDE.md to document the new shelly-deploy CD step and the deployer RBAC change.
