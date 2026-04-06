# Feature Specification: CD Pipeline Shelly Script Deployment

**Feature Branch**: `018-cd-shelly-deploy`
**Created**: 2026-04-07
**Status**: Draft
**Input**: User description: "Add a deploy step to the CD pipeline that runs deploy.sh from inside the pod in order to deploy the script(s) to shelly devices"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Shelly Script Deployment on Push (Priority: P1)

When a developer pushes changes to the main branch, the CD pipeline automatically deploys the updated Shelly scripts to the Shelly Pro 4PM device after the application pod is running. This eliminates the need for manual network access to update device scripts.

**Why this priority**: This is the core feature — without automatic deployment, Shelly script changes require manual intervention, which is error-prone and requires direct network access to the device.

**Independent Test**: Push a change to a Shelly script file, observe the CD pipeline run, and verify the Shelly Pro 4PM is running the updated script.

**Acceptance Scenarios**:

1. **Given** a push to main with changes to Shelly scripts, **When** the CD pipeline completes the app deployment and the pod is running, **Then** the pipeline deploys scripts to the Shelly Pro 4PM via the pod's VPN connection.
2. **Given** a push to main with no changes to Shelly scripts, **When** the CD pipeline runs, **Then** the Shelly deploy step still runs to ensure scripts remain in sync with the deployed image.
3. **Given** the Shelly device is unreachable (VPN down, device offline), **When** the deploy step runs, **Then** the pipeline completes successfully with a warning — Shelly deploy failure does not block the overall deployment.

---

### User Story 2 - Deployment Visibility (Priority: P2)

The operator can see the outcome of the Shelly script deployment in the CI/CD logs, including which device was targeted, whether the upload succeeded, and any errors encountered.

**Why this priority**: Observability is important for diagnosing deployment issues, but the system works without it.

**Independent Test**: Review the pipeline logs for a deployment run and confirm Shelly deploy output is visible.

**Acceptance Scenarios**:

1. **Given** a successful Shelly deployment, **When** the operator views the pipeline logs, **Then** they see the device IP, script slots deployed, and confirmation of success.
2. **Given** a failed Shelly deployment (device unreachable), **When** the operator views the pipeline logs, **Then** they see a clear error message indicating why the deployment failed, without the overall pipeline being marked as failed.

---

### Edge Cases

- What happens when the VPN tunnel is not yet established when the deploy step runs? The pod may need time after startup for the OpenVPN sidecar to connect.
- What happens when the Shelly device is mid-reboot during deployment?
- What happens when the script upload partially succeeds (some chunks uploaded, then connection lost)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The CD pipeline MUST execute the Shelly script deployment after the application pod is running and healthy.
- **FR-002**: The Shelly deploy step MUST run from inside the running pod, which has VPN access to the Shelly device via the OpenVPN sidecar.
- **FR-003**: The deploy step MUST deploy both the control script (control-logic.js + control.js) and the telemetry script to the Shelly Pro 4PM.
- **FR-004**: Shelly deploy failure MUST NOT cause the overall CD pipeline to fail — it is a non-fatal step.
- **FR-005**: The deploy step MUST wait for VPN connectivity to the Shelly device before attempting script upload.
- **FR-006**: The deploy step output (success or failure) MUST be visible in the pipeline logs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Shelly scripts are automatically deployed to the device on every push to main, with no manual intervention required.
- **SC-002**: A Shelly deploy failure does not prevent the application from being deployed and running.
- **SC-003**: The operator can determine from pipeline logs whether the Shelly deploy succeeded or failed, and why.
- **SC-004**: The deploy step tolerates VPN startup delays, waiting up to a reasonable timeout before reporting failure.

## Assumptions

- The deploy step runs from inside the already-running pod using `kubectl exec`, since the pod has VPN network access to the Shelly device.
- The existing `deploy.sh` script with `DEPLOY_VIA_VPN=true` is used as-is — no changes to the deploy script itself are needed.
- Only the Shelly Pro 4PM receives script deployments (valve controllers and sensor hosts do not run custom scripts).
- The CONTROLLER_IP and CONTROLLER_SCRIPT_ID are available as environment variables inside the pod (from the ConfigMap).
