# File Storage over NFS released

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
