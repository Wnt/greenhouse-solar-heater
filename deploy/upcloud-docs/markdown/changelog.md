# Changelog

[RSS Feed](/docs/changelog/index.xml.md)

Changelog is the source for the latest updates on our cloud platform. Stay informed about changes, enhancements, and new features that impact your experience. Explore our summaries to stay ahead and make the most of our platform's capabilities.

## File Storage over NFS released

February 6, 2026
·
[Permalink](/docs/changelog/2026-02-06-file-storage.md)

UpCloud is excited to announce the release of **File Storage**, our newest storage solution that completes our comprehensive storage portfolio. File Storage provides scalable, network-attached storage that can be shared using NFS across multiple Cloud Servers simultaneously.

File Storage is a fully managed NFS-based storage service that runs on your SDN Private Networks. It's designed for workloads that require shared access to the same data from multiple servers, such as:

- **Content management systems** with shared media libraries
- **Application clusters** requiring synchronized configuration or data files
- **Development environments** with shared code repositories and build artifacts
- **Data analytics** pipelines processing shared datasets
- **Backup and archival** solutions with centralized storage

Key features include:

- **Shared access**: Multiple servers can read and write to the same storage simultaneously
- **Scalable capacity**: Start with the capacity you need and expand as you grow
- **High availability**: Built on redundant infrastructure for reliability
- **Network isolation**: Accessible only over your private SDN networks for enhanced security
- **NFSv4.1 support**: Industry-standard protocol with modern features and performance
- **Simple management**: Create and manage shares through the UpCloud Hub or API

File Storage is initially available in **fi-hel2**, with expansion to additional locations planned:

- **Available now**: fi-hel2 (Helsinki)
- **Coming soon**: de-fra1 (Frankfurt), se-sto1 (Stockholm), us-nyc1 (New York)

With the addition of File Storage, UpCloud now offers a complete range of storage solutions to meet diverse application needs:

- **[Block Storage](/docs/products/block-storage.md)** - High-performance volumes attached directly to individual servers
- **[Object Storage](/docs/products/managed-object-storage.md)** - S3-compatible storage for unstructured data and static assets
- **[File Storage](/docs/products/file-storage.md)** - Shared network storage accessible from multiple servers via NFS

Check out our [File Storage guide](/docs/guides/file-sharing-over-nfs-on-ubuntu.md) for step-by-step instructions on setting up File Storage with Ubuntu servers.

## UpCloud opens a new location in Stavanger, Norway

January 21, 2026
·
[Permalink](/docs/changelog/2026-01-21-stavanger-dc.md)

We're pleased to announce the opening of a new data center in Stavanger, Norway.

UpCloud continues its expansion in the Nordics, enabling you to deploy compute resources closer to end-users across Scandinavia and Northern Europe, delivering superior performance for latency-critical workloads.

- **Zone Code:** `no-svg1`
- **Available Services:** All core UpCloud services are now available, including Cloud Servers with MaxIOPS storage, Managed Kubernetes, and more.
- **Performance:** Benefit from the same 99.999% SLA and high-performance infrastructure backed by AMD EPYC technology that powers our global network.

Start deploying in Stavanger today through the UpCloud Control Panel or API.

## Kubernetes v1.34 now available

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

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](2026-01-19-kubernetes-1.34/uks-upgrade-134.png)

Upgrade an UpCloud Managed Kubernetes cluster to v1.34

## Important Notes

- The managed upgrade feature is available only for clusters running Kubernetes 1.30 or newer.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.32 to v1.34, first upgrade to v1.33 and then to v1.34.

Kubernetes is a registered trademark of The Linux Foundation.

## New Datacenter Location: Copenhagen is now live

December 16, 2025
·
[Permalink](/docs/changelog/2025-12-16-copenhagen-dc.md)

We are thrilled to announce the general availability of our newest data center zone in Copenhagen, Denmark.

This launch strengthens our presence in the Nordic region, enabling to deploy resources closer to end-users in Denmark and surrounding areas, drastically reducing latency for performance-critical applications.

- **Zone Code:** `dk-cph1`
- **Available Services:** Deploy Cloud Servers with MaxIOPS storage, Managed Kubernetes, and all core UpCloud services immediately.
- **Performance:** Experience the same industry-leading performance and 99.999% SLA offered across our global network, powered by the latest AMD EPYC processors.

Deploy your servers in Copenhagen today via the UpCloud Control Panel or API!

## Kubernetes v1.33 now available

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

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](2025-12-09-kubernetes-1.33/uks-upgrade-133.png)

Upgrade an UpCloud Managed Kubernetes cluster to v1.33

## Important Notes

- The managed upgrade feature is available only for clusters running Kubernetes 1.30 or newer.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.31 to v1.33, first upgrade to v1.32 and then to v1.33.

Kubernetes is a registered trademark of The Linux Foundation.

[Next page](/docs/changelog/page/2.md)
