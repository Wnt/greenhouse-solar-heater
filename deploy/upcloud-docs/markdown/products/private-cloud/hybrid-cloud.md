# Hybrid cloud

Private Cloud is a dedicated environment for running [Cloud Servers](/docs/products/cloud-servers.md). The [same control panel and tooling](/docs/products/private-cloud/tooling.md) are used to control servers on Private Cloud, with extra features to enable visibility to Cloud Server hosts and enable fine grained control over server placement on these hosts.

## Hybrid use with public cloud

Private Clouds can be used in conjunction with services from the public cloud. A Private Cloud has its dedicated zone identifier (for example, `de-exa1`). Private Clouds are physically located within public zones, and can share resources with the parent public zone through private networks.

## Utilising SDN Private Networks across private and public zones

[SDN Private Networks](/docs/products/networking/sdn-private-networks.md) are shared between the Private Cloud and its parent public zone. Servers from both the public zone and the Private Cloud can join the same SDN Private Networks, and managed services from the public zone can be used from the Private Cloud.

![Attaching an SDN Private Network from the parent public zone](parent-zone-sdn-attach.png)

## Using Managed Services from Private Clouds

The following managed services on the parent public zones can be used from Private Clouds through SDN Private Networks.

- [Managed Load Balancer](/docs/products/managed-load-balancer.md)
- [Managed Object Storage](/docs/products/managed-object-storage.md)
- [Managed Databases for MySQL](/docs/products/managed-mysql.md)
- [Managed Databases for PostgreSQL](/docs/products/managed-postgresql.md)
- [Managed Databases for OpenSearch](/docs/products/managed-opensearch.md)
- [Managed Databases for Valkey](/docs/products/managed-valkey.md)
- [Managed Kubernetes](/docs/products/managed-kubernetes.md)

Managed Services include the cloud resources they are run on, and cannot be deployed on Private Cloud hosts.
