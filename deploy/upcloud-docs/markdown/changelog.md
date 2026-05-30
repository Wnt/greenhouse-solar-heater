# Changelog

[RSS Feed](/docs/changelog/index.xml.md)

Changelog is the source for the latest updates on our cloud platform. Stay informed about changes, enhancements, and new features that impact your experience. Explore our summaries to stay ahead and make the most of our platform's capabilities.

## New GPU Servers: NVIDIA L4, H100, and B200

May 18, 2026
·
[Permalink](/docs/changelog/2026-05-18-h100-b200-gpus.md)

We are expanding our GPU Server lineup with three new GPU options — NVIDIA L4, H100, and B200 — joining the existing NVIDIA L40S plans.

**NVIDIA L4** is well-suited for image generation, speech-to-text, and basic inference workloads. Plans are available with 1, 2, or 3 GPUs and up to 32 CPU cores and 384 GB of RAM.

**NVIDIA H100** targets high-traffic inference, large-scale batch processing, and model training. Multi-GPU configurations of 2, 4, and 8 GPUs are available, scaling up to 96 CPU cores and 1920 GB of RAM. All H100 plans include NVLink, providing 900 GB/s of bidirectional GPU-to-GPU bandwidth for efficient distributed workloads.

**NVIDIA B200** is designed for the most demanding AI workloads, including trillion-parameter model inference and real-time complex model execution. Multi-GPU configurations with NVLink are available, offering 1.8 TB/s of GPU-to-GPU bandwidth.

All new plans follow the same billing model as existing GPU Servers — you are only charged when the server is powered on. See the [GPU Server configurations](/docs/products/gpu-servers/configurations.md) page for the full list of available plans.

## MySQL v8.4 LTS now available

April 28, 2026
·
[Permalink](/docs/changelog/2026-04-28-mysql-8.4.md)

We are pleased to announce the availability of MySQL v8.4 Long-Term Support (LTS) on UpCloud's Managed Databases Service.

## What's New

As the first Long-Term Support release in [MySQL's updated release lifecycle](https://dev.mysql.com/blog-archive/introducing-mysql-innovation-and-long-term-support-lts-versions/), MySQL 8.4 focuses on long-term stability, security patches, and critical bug fixes. It introduces refined engine defaults, performance optimizations for InnoDB workloads, and strengthened cryptographic standards. For comprehensive information about new features and structural modifications, please refer to the official [MySQL 8.4 release notes](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/).

## Deployment Options

You can deploy MySQL 8.4 database instances through the following methods:

- Create a new database instance via the [UpCloud Control Panel](https://hub.upcloud.com/database/new)
- Upgrade an existing instance to MySQL v8.4 through UpCloud Hub or through the [UpCloud API](https://developers.upcloud.com/1.3/16-managed-database/#migration-check-task-mysql-postgresql).

![UpCloud Managed Databases Service version upgrade, as displayed in the details card of the overview tab in UpCloud Hub](2026-04-28-mysql-8.4/mysql_8_4_upgrade_available.png)

In-place upgrade of an UpCloud Managed Database from MySQL 8.0 to MySQL v8.4

![UpCloud Managed Databases Service version upgrade confirmation modal in UpCloud Hub](2026-04-28-mysql-8.4/mysql_8_4_upgrade_available_2.png)

Confirmation modal for the upgrade of an UpCloud Managed Database to MySQL v8.4

## Important Notes

- **Upgrades are irreversible**: Major version upgrades modify data directories permanently. We highly recommend testing the upgrade path on a [clone of your service](https://developers.upcloud.com/1.3/16-managed-database/#clone-managed-database) before applying it to your production environments.
- **Authentication & Legacy Compatibility**: MySQL 8.4's has moved on the `caching_sha2_password` authentication mechanism. However, to ensure seamless, zero-downtime upgrades for existing applications that still rely on legacy drivers, the `mysql_native_password` plugin remains loaded and available by default.

MySQL is a registered trademark of Oracle and/or its affiliates.

## Kubernetes v1.35 now available

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

![UpCloud Managed Kubernetes Service version upgrade available, as displayed in the settings tab in UpCloud Hub](2026-04-16-kubernetes-1.35/uks-upgrade-1_35-available.png)

Upgrade available for an UpCloud Managed Kubernetes cluster 1.34 to v1.35

![UpCloud Managed Kubernetes Service version upgrade, as displayed in the settings tab in UpCloud Hub](2026-04-16-kubernetes-1.35/uks-upgrade-1_35.png)

Rolling upgrade of an UpCloud Managed Kubernetes cluster to v1.35

## Important Notes

- The managed upgrade feature is available **only for clusters running Kubernetes 1.30 or newer**.
- When upgrading Kubernetes versions, you must upgrade one minor at the time. For example, when upgrading from Kubernetes v1.33 to v1.35, first upgrade to v1.34 and then to v1.35.

Kubernetes is a registered trademark of The Linux Foundation.

## Starter & Premium servers available

April 15, 2026
·
[Permalink](/docs/changelog/2026-04-15-starter-premium-servers.md)

We are introducing two new Cloud Server plan families: **Starter** and **Premium**.

These plans are designed to make sizing easier from day one. Choose Starter when you want dependable capacity at a lower cost, and Premium when your production workloads require top-tier CPU and storage performance.

### Starter plans

Starter plans are built for practical day-to-day workloads such as:

- Development and test environments
- Self-hosted tools and internal services
- Small web applications and staging setups

Starter uses previous-generation hardware to provide predictable performance at an efficient price point.

### Premium plans

Premium plans are built for high-demand production workloads where performance is critical:

- Business-critical applications
- Databases and data-heavy services
- Latency-sensitive APIs and backend platforms

Premium plans run on the latest AMD EPYC CPU platforms and include MaxIOPS storage for consistently high I/O performance.

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

[Next page](/docs/changelog/page/2.md)
