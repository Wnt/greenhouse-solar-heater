# Dedicated resources in Private Cloud

Private Clouds offer [Cloud Servers](/docs/products/cloud-servers.md) within an isolated environment, where servers operate on dedicated Cloud Server hosts, granting you [complete control over server placement](/docs/products/private-cloud/capacity-management.md). In addition to Cloud Server hosts, Private Clouds can integrate dedicated storage hosts and network connections, providing a further isolated environment and more connectivity options. Private Cloud offers the possibility for dedicated public IP blocks, and it is possible to utilise your own IP blocks (BYOIP).

## Private Clouds and parent zones

Private Clouds are physically located within a parent public zone among our [13 locations](/docs/products/cloud-servers/availability.md).
Private Clouds share some services with the public zone, such as the block storage system and connections to the public Internet, all of which can be optionally dedicated.

[SDN Private Networks](/docs/products/networking/sdn-private-networks.md) can be utilised across private and public zones. Servers from both public and private zones can join the same networks, and managed services from the public zone can be used from the Private Cloud.

UpCloud's [Utility network](/docs/products/networking/utility-network.md) connects all servers across all zones to an easy-to-use global network, facilitating quick access from any server under the same account. The Utility network also connect servers in Private Clouds.

## What is dedicated

| Resource | Always dedicated | Can be dedicated | Available from parent public zone |
| --- | --- | --- | --- |
| Cloud Servers | ✓ |  |  |
| Block Storage |  | ✓ | ✓ |
| Networking |  | ✓ | ✓ |
| Managed Services |  |  | ✓ |

Managed Services include [Managed Kubernetes](/docs/products/managed-kubernetes.md), [Managed Load Balancer](/docs/products/managed-load-balancer.md) and Managed Databases for [MySQL](/docs/products/managed-mysql.md), [PostgreSQL](/docs/products/managed-postgresql.md), [OpenSearch](/docs/products/managed-opensearch.md) and [Valkey](/docs/products/managed-valkey.md).
