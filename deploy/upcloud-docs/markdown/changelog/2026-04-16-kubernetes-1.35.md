# Kubernetes v1.35 now available

April 16, 2026
·
[Permalink](/docs/changelog/2026-04-16-kubernetes-1.35.md)

We are pleased to announce the [renewal of our Kubernetes certification on v1.35](https://github.com/cncf/k8s-conformance/pull/4173) and the availability of Kubernetes v1.35 on UpCloud's Managed Kubernetes Service (UKS).

## What's New

Similar to previous releases, the release of Kubernetes v1.35 introduces new stable, beta, and alpha features. For comprehensive information about new features and improvements, please refer to the official [Kubernetes 1.35 release notes](https://kubernetes.io/blog/2025/12/17/kubernetes-v1-35-release/).

## Deployment Options

You can deploy Kubernetes 1.35 clusters through the following methods:

- Create a new cluster via the [UpCloud Control Panel](https://hub.upcloud.com/kubernetes/new)
- Upgrade an existing cluster to Kubernetes v1.35 through UpCloud Hub or through the [UpCloud API](https://developers.upcloud.com/1.3/20-managed-kubernetes/#upgrade-cluster).

![UpCloud Managed Kubernetes Service version upgrade available, as displayed in the settings tab in UpCloud Hub](uks-upgrade-1_35-available.png)

Upgrade available for an UpCloud Managed Kubernetes cluster 1.34 to v1.35

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](uks-upgrade-1_35.png)

Rolling upgrade of an UpCloud Managed Kubernetes cluster to v1.35

## Important Notes

- The managed upgrade feature is available **only for clusters running Kubernetes 1.30 or newer**.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.33 to v1.35, first upgrade to v1.34 and then to v1.35.

Kubernetes is a registered trademark of The Linux Foundation.
