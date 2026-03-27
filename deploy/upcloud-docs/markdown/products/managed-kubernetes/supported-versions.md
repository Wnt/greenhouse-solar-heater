# Managed Kubernetes Supported versions

We currently support the following Kubernetes versions with full SLA guarantees and regular security patching:

- Kubernetes 1.34 with Cilium v1.18.1
- Kubernetes 1.33 with Cilium v1.18.1
- Kubernetes 1.32 with Cilium v1.18.0
- Kubernetes 1.31 with Cilium v1.17.0
- Kubernetes 1.30 with Cilium v1.17.0

### Legacy versions (End-of-Life)

The following versions have reached End-of-Life (EOL) status. They are maintained on a **best-effort basis** to allow for migration to the new cluster architecture:

- Kubernetes 1.29 with Cilium v1.16.1
- Kubernetes 1.28 with Cilium v1.16.1
- Kubernetes 1.27
- Kubernetes 1.26

**Important notes on Legacy versions:**

- **SLA:** These versions are no longer covered by the UpCloud Service Level Agreement.
- **Support:** Technical support is provided on a best-effort basis only. No new security patches or bug fixes will be released for these versions.
- **Maintenance Fee:** Clusters running these versions may incur a Legacy Infrastructure Maintenance surcharge. We expect to begin applying this fee to remaining legacy clusters in **Q4 2026**.

We strongly recommend [migrating to a cluster running Kubernetes 1.30](/docs/guides/migration-uks-velero.md) or newer to ensure full support and access to automated in-place upgrades.

See Kubernetes project [Releases](https://kubernetes.io/releases/) for information on version support schedules.

Kubernetes is a registered trademark of The Linux Foundation.
