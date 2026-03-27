# Container Storage Interface

UpCloud’s built-in Container Storage Interface (CSI) comes as standard for all Kubernetes® clusters and automates storage volumes for users.

The UpCloud CSI plugin allows users to create stateful workloads by managing storage volumes and is a built-in feature of all Managed Kubernetes clusters. CSI plugin supports all storage features, including snapshots, cloning and encryption at rest.

The Container Storage Interface (CSI) is used to expose block and file storage systems to containerized workloads on Kubernetes. CSI ensures storage system compatibility with the core Kubernetes code.

The plugin is open source and [available in GitHub](https://github.com/UpCloudLtd/upcloud-csi).

## Getting started

See [Kubernetes storage related guides](/docs/guides/managed-kubernetes.md).

## Supported storage tiers

All UpCloud block storage tiers are supported by the driver through the following `storageClassName` values:

- MaxIOPS: `upcloud-block-storage-maxiops`
- Standard: `upcloud-block-storage-standard`
- HDD: `upcloud-block-storage-hdd`

You can define your selected storage tier upon creating the Persistent Volume.

## Share your feedback

Please reach out to us through [GitHub issues](https://github.com/UpCloudLtd/upcloud-csi/issues). We would love to hear your feedback!

Kubernetes is a registered trademark of The Linux Foundation.
