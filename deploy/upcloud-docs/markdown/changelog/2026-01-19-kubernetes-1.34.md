# Kubernetes v1.34 now available

January 19, 2026
·
[Permalink](/docs/changelog/2026-01-19-kubernetes-1.34.md)

We are pleased to announce the [renewal of our Kubernetes certification on v1.34](https://github.com/cncf/k8s-conformance/pull/4035) and the availability of Kubernetes v1.34 on UpCloud's Managed Kubernetes Service (UKS).

## What's New

Similar to previous releases, the release of Kubernetes v1.34 introduces new stable, beta, and alpha features. For comprehensive information about new features and improvements, please refer to the official [Kubernetes 1.34 release notes](https://kubernetes.io/blog/2025/08/27/kubernetes-v1-34-release/).

## Deployment Options

You can deploy Kubernetes 1.34 clusters through the following methods:

- Create a new cluster via the [UpCloud Control Panel](https://hub.upcloud.com/kubernetes/new)
- Upgrade an existing cluster to Kubernetes v1.34 through UpCloud Hub or through the [UpCloud API](https://developers.upcloud.com/1.3/20-managed-kubernetes/#upgrade-cluster).

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](uks-upgrade-134.png)

Upgrade an UpCloud Managed Kubernetes cluster to v1.34

## Important Notes

- The managed upgrade feature is available only for clusters running Kubernetes 1.30 or newer.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.32 to v1.34, first upgrade to v1.33 and then to v1.34.

Kubernetes is a registered trademark of The Linux Foundation.
