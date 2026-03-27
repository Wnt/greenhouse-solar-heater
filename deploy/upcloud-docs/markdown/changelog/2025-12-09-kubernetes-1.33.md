# Kubernetes v1.33 now available

December 9, 2025
·
[Permalink](/docs/changelog/2025-12-09-kubernetes-1.33.md)

We are pleased to announce the [renewal of our Kubernetes certification on v1.33](https://github.com/cncf/k8s-conformance/pull/3986) and the availability of Kubernetes v1.33 on UpCloud's Managed Kubernetes Service (UKS).

## What's New

New alpha and beta features along with improvements that are now stable. For a comprehensive changelog, please refer to the official [Kubernetes 1.33 release notes](https://kubernetes.io/blog/2025/04/23/kubernetes-v1-33-release/).

## Deployment Options

You can deploy Kubernetes 1.33 clusters through the following methods:

- Create a new cluster via the [UpCloud Control Panel](https://hub.upcloud.com/kubernetes/new)
- Upgrade an existing cluster to Kubernetes v1.33 through UpCloud Hub or through the [UpCloud API](https://developers.upcloud.com/1.3/20-managed-kubernetes/#upgrade-cluster).

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](uks-upgrade-133.png)

Upgrade an UpCloud Managed Kubernetes cluster to v1.33

## Important Notes

- The managed upgrade feature is available only for clusters running Kubernetes 1.30 or newer.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.31 to v1.33, first upgrade to v1.32 and then to v1.33.

Kubernetes is a registered trademark of The Linux Foundation.
