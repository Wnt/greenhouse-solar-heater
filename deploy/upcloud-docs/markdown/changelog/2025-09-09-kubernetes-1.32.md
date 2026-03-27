# Kubernetes v1.32 now available

September 9, 2025
·
[Permalink](/docs/changelog/2025-09-09-kubernetes-1.32.md)

We are pleased to announce the [renewal of our Kubernetes certification on v1.32](https://github.com/cncf/k8s-conformance/pull/3858) and the availability of Kubernetes v1.32 on UpCloud's Managed Kubernetes Service (UKS).

## What's New

For comprehensive information about new features and improvements, please refer to the official [Kubernetes 1.32 release notes](https://kubernetes.io/blog/2024/12/11/kubernetes-v1-32-release/).

## Deployment Options

You can deploy Kubernetes 1.32 clusters through the following methods:

- Create a new cluster via the [UpCloud control panel](https://hub.upcloud.com/kubernetes/new)
- Upgrade an existing cluster to Kubernetes v1.32 through UpCloud Hub or through the [UpCloud API](https://developers.upcloud.com/1.3/20-managed-kubernetes/#upgrade-cluster).

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](image.png)

Upgrade an UpCloud Managed Kubernetes cluster to v1.32

## Important Notes

- The managed upgrade feature is available only for clusters running Kubernetes 1.30 or newer.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.30 to v1.32, first upgrade to v1.31 and then to v1.32.

Kubernetes is a registered trademark of The Linux Foundation.
