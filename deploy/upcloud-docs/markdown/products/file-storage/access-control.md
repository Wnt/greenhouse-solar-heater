# File Storage Access Control

## Network-based access control

File Storage shares are accessed exclusively through [SDN Private Networks](/docs/products/networking/sdn-private-networks.md), providing secure, isolated connectivity between your Cloud Servers and storage volumes.

Each File Storage instance connects to a single SDN Private Network. You can further restrict access to individual shares by specifying subnet-level permissions, allowing fine-grained control over which servers can access specific storage volumes. This enables you to create multiple security zones within your infrastructure while using the same File Storage instance.

## Read/write and read-only permissions

File Storage supports flexible permission models for controlling how different servers interact with your data:

- **Read/Write Access**: Servers with read/write permissions can create, modify, and delete files on the share, allowing full data management capabilities.
- **Read-Only Access**: Servers with read-only permissions can access and read files but cannot make modifications, ensuring data integrity and preventing accidental changes.

The same share can have different permission levels for different servers on the same network. This enables common access patterns such as:

- **Multi-tier architectures**: Application servers with read/write access alongside read-only analytics or reporting servers.
- **Data replication**: Source servers with write access and backup servers with read-only access.

## Example access control configuration

The following example demonstrates a typical multi-tier access control setup:

| Share | Permissions | Subnet | Use Case |
| --- | --- | --- | --- |
| /logs | read-write | 192.168.1.0/26 | Application servers writing to centralized logging |
| /logs | read-only | 192.168.1.0/28 | Monitoring and analytics servers for log analysis |

## Network isolation and security

By leveraging SDN Private Networks, File Storage access control provides:

- **Private connectivity**: All NFS traffic remains within your private network infrastructure.
- **No public exposure**: Shares are not accessible from the public internet.
- **Subnet-level granularity**: Restrict access to specific subnets within your SDN private network.
- **Dynamic access control**: Add or remove servers and modify permissions without downtime.
