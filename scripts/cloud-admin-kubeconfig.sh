#!/usr/bin/env bash
# Generate the kubeconfig for the Claude cloud env / incident-automation routine.
#
# Prerequisites: a working local admin kubeconfig (e.g. the one kubectl uses by
# default) that can read the cloud-admin-token Secret in the default namespace.
#
# Usage:
#   ./scripts/cloud-admin-kubeconfig.sh           # prints kubeconfig YAML to stdout
#   ./scripts/cloud-admin-kubeconfig.sh --base64  # prints base64-encoded kubeconfig
#                                                  # (paste into KUBECONFIG_B64 env var
#                                                  #  in the Claude cloud env)
set -euo pipefail

SERVER="https://k8s.greenhouse.madekivi.fi"

# Read the token from the cluster (requires local admin access).
TOKEN=$(kubectl get secret cloud-admin-token -n default \
  -o jsonpath='{.data.token}' | base64 -d)

KUBECONFIG_YAML=$(cat <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: greenhouse
    cluster:
      server: ${SERVER}
      # Public Let's Encrypt cert — no custom CA needed.
contexts:
  - name: greenhouse
    context:
      cluster: greenhouse
      user: cloud-admin
      namespace: default
current-context: greenhouse
users:
  - name: cloud-admin
    user:
      token: ${TOKEN}
EOF
)

if [[ "${1:-}" == "--base64" ]]; then
  printf '%s' "$KUBECONFIG_YAML" | base64
else
  printf '%s\n' "$KUBECONFIG_YAML"
fi
