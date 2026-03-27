# File Storage Concepts

## NFS (Network File System)

NFS is a distributed file system protocol that allows servers to access files and directories over a network as if they were mounted locally. File Storage uses NFS to provide shared storage that can be simultaneously accessed by multiple Cloud Servers.

With NFS, your applications can read and write to shared files. The storage appears as a standard file system mount point, making it easy to integrate with existing applications and workflows without code changes.

## Geographic location

File Storage instances must be created within the same geographic location as your Cloud Servers. This ensures optimal performance, low latency network access, and compliance with data residency requirements.

Currently, File Storage is available in the **fi-hel2** (Helsinki 2) location. All servers accessing a File Storage instance must be in the same location.

## Limits and constraints

### File Storage instance capacity

File Storage instances are available starting from 250 GiB to a maximum of 25,000 GiB per instance. You can select the capacity that best fits your storage requirements during instance creation. If you need more capacity, you can resize the instance or create additional instances. An instance size cannot be shrunk.

### File size limits

Individual files on a File Storage can be up to 16 TiB in size.

### Maximum number of shares

A maximum of 50 shares can be created on each File Storage instance. This enables you to partition storage into separate logical volumes with independent access controls while using a single storage space.

## Maximum number of files

The maximum number of files on each File Storage instance is limited by the available number of inodes, which is set at creation and cannot be increased. Resizing the instance does not increase the amount of available inodes. This limitation can be bypassed by creating a large File Storage.

The number of available and used inodes can be examined on Linux systems with the `df -i` command.

## Instances vs. shares

Understanding the difference between shares and instances is essential for effective storage organization:

- **File Storage instance**: The main storage container and billing unit. Each instance is connected to a single SDN Private Network and includes a specific storage capacity (e.g., 250 GB, 1 TB).
- **Shares**: Individual logical volumes within a File Storage instance. Multiple shares allow you to organize data logically and apply different access controls independently without creating separate storage instances. All shares within a File Storage instance share the available storage capacity.

A single instance with multiple shares is more efficient and cost-effective than creating separate instances. For example, you might use one instance with three shares: `/app-data`, `/logs`, and `/backups`, each with different read/write permissions.

## Network attachment

File Storage instances are exclusively attached to a single [SDN Private Network](/docs/products/networking/sdn-private-networks.md). All access to shares must occur through this private network, ensuring secure, isolated connectivity.

While an instance is fixed to one network, you can connect multiple servers from that network to the same shares. You can also restrict access to specific subnets within the network for additional security. If you need File Storage to be accessible from multiple isolated networks, you would need separate instances in each network.

## Supported versions

File Storage supports NFS protocol version 4.1.
