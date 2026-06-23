# Cloud Env → Cluster Access for Incident Automation

## What and Why

The Claude cloud routine that handles incident auto-remediation needs full `kubectl` access to the production Kubernetes cluster. The cloud env can only egress on ports 80 and 443; the UpCloud managed control plane is on `:7443` (unreachable from there).

**Solution**: An NGINX Ingress L7 proxy on `k8s.greenhouse.madekivi.fi:443` that forwards to the in-cluster apiserver alias `kubernetes.default.svc:443`. This is **not** ssl-passthrough — NGINX terminates TLS with a Let's Encrypt cert and re-initiates HTTPS to the backend. kubectl WebSocket streams (used by `port-forward` and `exec`) carry through L7 termination unchanged; this was validated with kubectl 1.35 before being codified into the repo.

**Resources** (`deploy/k8s/cloud-admin.yaml`, `deploy/k8s/k8s-api-proxy.yaml`):

- `ServiceAccount/cloud-admin` (ns default) — identity for the cloud env.
- `ClusterRoleBinding/cloud-admin` → built-in `cluster-admin` ClusterRole — full cluster access.
- `Secret/cloud-admin-token` (type `kubernetes.io/service-account-token`) — long-lived bearer token; controller auto-populates `.data.token`.
- `Ingress/k8s-api-proxy` — routes `k8s.greenhouse.madekivi.fi` → `kubernetes:443`.

These resources are already live in prod. CD re-applying them via kustomize is idempotent.

## Security Posture

The cluster API was already publicly reachable on `:7443` (no `control_plane_ip_filter` configured in UpCloud). Exposing it on `:443` via this Ingress does not change the attack surface class — it just changes the port. The LE certificate eliminates the cert-warning noise from older kubectl versions.

**The token is the crown jewel.** Anyone who obtains the `cloud-admin-token` value has unrestricted cluster-admin access. Mitigations:

- **Instant revocation**: `kubectl delete clusterrolebinding cloud-admin`. The SA and token Secret can remain; without the binding the token has zero permissions. Restoration: `kubectl apply -f deploy/k8s/cloud-admin.yaml`.
- **Rotation**: `kubectl delete secret cloud-admin-token -n default`. The controller recreates the Secret with a fresh token within seconds. Re-run the kubeconfig script below and update the cloud env's `KUBECONFIG_B64`.
- **Independent from CI/CD**: The cloud-admin SA is completely separate from the `deployer` SA used by GitHub Actions. Revoking one does not affect the other.

Store the kubeconfig (or its base64 form) only in the Claude cloud env's secret environment variables, never in plaintext files, logs, or PR descriptions.

## Generating the Kubeconfig

You need a working local admin kubeconfig (e.g. the one `kubectl` uses by default, with access to the `default` namespace and the `cloud-admin-token` Secret).

```bash
# Print kubeconfig YAML to stdout
./scripts/cloud-admin-kubeconfig.sh

# Print base64-encoded kubeconfig (for KUBECONFIG_B64 env var in the cloud env)
./scripts/cloud-admin-kubeconfig.sh --base64
```

In the Claude cloud env, set the environment variable:

```
KUBECONFIG_B64=<output of --base64>
```

Then in the routine, decode it before use:

```bash
echo "$KUBECONFIG_B64" | base64 -d > /tmp/kube.yaml
export KUBECONFIG=/tmp/kube.yaml
kubectl get nodes
```

The kubeconfig points at `https://k8s.greenhouse.madekivi.fi` (public LE cert — no `certificate-authority-data` needed).

## Device RPC Recipe (Validated)

The cloud env cannot reach Shelly devices directly. The `app` container's `openvpn` sidecar creates a VPN tunnel to the home LAN, so executing a command inside the `app` container reaches any LAN device.

```bash
# Shelly Pro 4PM is at 192.168.30.50, auth disabled (auth_en: false)
kubectl exec deploy/app -c app -n default -- \
  curl -sS http://192.168.30.50/rpc/Switch.GetStatus?id=0

# Restart the Shelly script (incident remediation example)
kubectl exec deploy/app -c app -n default -- \
  curl -sS -X POST http://192.168.30.50/rpc/Script.Start \
  -H 'Content-Type: application/json' \
  -d '{"id":1}'
```

No SOCKS proxy, SSH tunnel, or additional sidecar is needed — `kubectl exec` through the L7 proxy is sufficient.

Other device addresses (from `system.yaml`):
- Valve controller Pro 2PM units: see `system.yaml` → `devices`
- Sensor hub Plus 1 with Add-on: see `system.yaml` → `devices`

## Already Live

The `cloud-admin` SA, ClusterRoleBinding, token Secret, and `k8s-api-proxy` Ingress were applied directly to prod during validation before this PR. CD re-applying them is idempotent. The LE cert for `k8s.greenhouse.madekivi.fi` is provisioned by cert-manager from the Ingress `tls` block and should be Ready within ~2 min of the first apply.
