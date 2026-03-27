# Cloud Server configurations

Cloud Servers can be provisioned with five different plan types, each offering distinct combinations of resources, SLA levels, and included services for different use cases.

- [Developer plans](/docs/products/cloud-servers/configurations#developer-plans.md)
- [General Purpose plans](/docs/products/cloud-servers/configurations#general-purpose-plans.md)
- [Cloud Native plans](/docs/products/cloud-servers/configurations#cloud-native-plans.md)
- [Common features across plans](/docs/products/cloud-servers/configurations#common-features-across-plans.md)
- [Discontinued plans](/docs/products/cloud-servers/configurations#discontinued-plans.md)

## Developer plans

Developer server plans offer a cost-effective solution with reliable performance, perfect for experimenting and building your projects.

**Plans include**

- CPU & Memory
- Standard block storage
- 1 public IPv4 & IPv6 address
- 99.99% SLA

**Add-ons**

- Extra block storage ([any tier](/docs/products/block-storage/tiers.md))
- Extra IP addresses
- Backup options

| CPU cores | RAM | Standard Storage | Identifier |
| --- | --- | --- | --- |
| 1 core | 1 GB | 10 GB | DEV-1xCPU-1GB-10GB |
| 1 core | 1 GB | 20 GB | DEV-1xCPU-1GB |
| 1 core | 2 GB | 30 GB | DEV-1xCPU-2GB |
| 1 core | 4 GB | 40 GB | DEV-1xCPU-4GB |
| 2 cores | 4 GB | 60 GB | DEV-2xCPU-4GB |
| 2 cores | 8 GB | 80 GB | DEV-2xCPU-8GB |
| 2 cores | 16 GB | 100 GB | DEV-2xCPU-16GB |

Instance restrictions:

- The DEV-1xCPU-1GB-10GB plan is restricted to 2 instances per account.
- The DEV-1xCPU-1GB plan is restricted to 5 instances per account.

## General Purpose plans

General Purpose plans offer a balanced amount of resources for various use-cases. General Purpose plans include also High CPU and High Memory options.

**Plans include**

- CPU & Memory
- MaxIOPS™ block storage
- 1 public IPv4 & IPv6 address
- 24h backup for included storage
- 99.999% SLA

**Add-ons**

- Extra block storage ([any tier](/docs/products/block-storage/tiers.md))
- Extra IP addresses
- More backup options

[General Purpose](/docs/products/cloud-servers/configurations#gp-configs-general-purpose.md) [High CPU](/docs/products/cloud-servers/configurations#gp-configs--high-cpu.md) [High Memory](/docs/products/cloud-servers/configurations#gp-configs--high-memory.md)

| CPU cores | RAM | MaxIOPS Storage | Identifier |
| --- | --- | --- | --- |
| 1 core | 1 GB | 25 GB | 1xCPU-1GB |
| 1 core | 2 GB | 50 GB | 1xCPU-2GB |
| 2 cores | 2 GB | 60 GB | 2xCPU-2GB |
| 2 cores | 4 GB | 80 GB | 2xCPU-4GB |
| 4 cores | 8 GB | 160 GB | 4xCPU-8GB |
| 6 cores | 16 GB | 320 GB | 6xCPU-16GB |
| 8 cores | 32 GB | 640 GB | 8xCPU-32GB |
| 12 cores | 48 GB | 960 GB | 12xCPU-48GB |
| 16 cores | 64 GB | 1280 GB | 16xCPU-64GB |
| 24 cores | 96 GB | 1920 GB | 24xCPU-96GB |
| 32 cores | 128 GB | 2048 GB | 32xCPU-128GB |
| 38 cores | 192 GB | 2048 GB | 38xCPU-192GB |
| 48 cores | 256 GB | 2048 GB | 48xCPU-256GB |
| 64 cores | 384 GB | 2048 GB | 64xCPU-384GB |
| 80 cores | 512 GB | 2048 GB | 80xCPU-512GB |

| CPU cores | RAM | MaxIOPS Storage | Identifier |
| --- | --- | --- | --- |
| 8 cores | 12 GB | 100 GB | HICPU-8xCPU-12GB |
| 8 cores | 16 GB | 200 GB | HICPU-8xCPU-16GB |
| 16 cores | 24 GB | 100 GB | HICPU-16xCPU-24GB |
| 16 cores | 32 GB | 200 GB | HICPU-16xCPU-32GB |
| 32 cores | 48 GB | 200 GB | HICPU-32xCPU-48GB |
| 32 cores | 64 GB | 300 GB | HICPU-32xCPU-64GB |
| 64 cores | 96 GB | 200 GB | HICPU-64xCPU-96GB |
| 64 cores | 128 GB | 300 GB | HICPU-64xCPU-128GB |

| CPU cores | RAM | MaxIOPS Storage | Identifier |
| --- | --- | --- | --- |
| 2 cores | 8 GB | 100 GB | HIMEM-2xCPU-8GB |
| 2 cores | 16 GB | 100 GB | HIMEM-2xCPU-16GB |
| 4 cores | 32 GB | 100 GB | HIMEM-4xCPU-32GB |
| 4 cores | 64 GB | 200 GB | HIMEM-4xCPU-64GB |
| 6 cores | 128 GB | 300 GB | HIMEM-6xCPU-128GB |
| 8 cores | 192 GB | 400 GB | HIMEM-8xCPU-192GB |
| 12 cores | 256 GB | 500 GB | HIMEM-12xCPU-256GB |
| 16 cores | 384 GB | 600 GB | HIMEM-16xCPU-384GB |
| 24 cores | 512 GB | 700 GB | HIMEM-24xCPU-512GB |

## Cloud Native plans

Cloud Native plans offer the best possible resource pricing for CPU & memory without bundled storage or IP addresses. Cloud Native plans have been designed to be used with [Managed Kubernetes](/docs/products/managed-kubernetes.md), but can be used in any application.

**Plans include**

- CPU & Memory
- 99.999% SLA
- Billed only when server is started

**Add-ons**

- Block storage ([any tier](/docs/products/block-storage/tiers.md))
- Public IP addresses
- Backup options

| CPU cores | RAM | Storage | Identifier |
| --- | --- | --- | --- |
| 1 core | 4 GB | Any size, any tier | CLOUDNATIVE-1xCPU-4GB |
| 2 cores | 4 GB | 〃 | CLOUDNATIVE-2xCPU-4GB |
| 1 cores | 8 GB | 〃 | CLOUDNATIVE-1xCPU-8GB |
| 2 cores | 8 GB | 〃 | CLOUDNATIVE-2xCPU-8GB |
| 2 cores | 16 GB | 〃 | CLOUDNATIVE-2xCPU-16GB |
| 4 cores | 8 GB | 〃 | CLOUDNATIVE-4xCPU-8GB |
| 4 cores | 16 GB | 〃 | CLOUDNATIVE-4xCPU-16GB |
| 6 cores | 16 GB | 〃 | CLOUDNATIVE-6xCPU-16GB |
| 8 cores | 16 GB | 〃 | CLOUDNATIVE-8xCPU-16GB |
| 4 cores | 24 GB | 〃 | CLOUDNATIVE-4xCPU-24GB |
| 6 cores | 24 GB | 〃 | CLOUDNATIVE-6xCPU-24GB |
| 8 cores | 24 GB | 〃 | CLOUDNATIVE-8xCPU-24GB |
| 12 cores | 24 GB | 〃 | CLOUDNATIVE-12xCPU-24GB |
| 4 cores | 32 GB | 〃 | CLOUDNATIVE-4xCPU-32GB |
| 8 cores | 32 GB | 〃 | CLOUDNATIVE-8xCPU-32GB |
| 12 cores | 32 GB | 〃 | CLOUDNATIVE-12xCPU-32GB |
| 16 cores | 32 GB | 〃 | CLOUDNATIVE-16xCPU-32GB |
| 4 cores | 48 GB | 〃 | CLOUDNATIVE-4xCPU-48GB |
| 8 cores | 48 GB | 〃 | CLOUDNATIVE-8xCPU-48GB |
| 16 cores | 48 GB | 〃 | CLOUDNATIVE-16xCPU-48GB |
| 8 cores | 64 GB | 〃 | CLOUDNATIVE-8xCPU-64GB |
| 16 cores | 64 GB | 〃 | CLOUDNATIVE-16xCPU-64GB |
| 20 cores | 64 GB | 〃 | CLOUDNATIVE-20xCPU-64GB |
| 32 cores | 64 GB | 〃 | CLOUDNATIVE-32xCPU-64GB |
| 8 cores | 96 GB | 〃 | CLOUDNATIVE-8xCPU-96GB |
| 16 cores | 96 GB | 〃 | CLOUDNATIVE-16xCPU-96GB |
| 20 cores | 96 GB | 〃 | CLOUDNATIVE-20xCPU-96GB |
| 8 cores | 128 GB | 〃 | CLOUDNATIVE-8xCPU-128GB |
| 16 cores | 128 GB | 〃 | CLOUDNATIVE-16xCPU-128GB |
| 32 cores | 128 GB | 〃 | CLOUDNATIVE-32xCPU-128GB |
| 16 cores | 192 GB | 〃 | CLOUDNATIVE-16xCPU-192GB |
| 32 cores | 192 GB | 〃 | CLOUDNATIVE-32xCPU-192GB |
| 64 cores | 192 GB | 〃 | CLOUDNATIVE-64xCPU-192GB |
| 24 cores | 256 GB | 〃 | CLOUDNATIVE-24xCPU-256GB |
| 32 cores | 256 GB | 〃 | CLOUDNATIVE-32xCPU-256GB |
| 64 cores | 256 GB | 〃 | CLOUDNATIVE-64xCPU-256GB |
| 32 cores | 384 GB | 〃 | CLOUDNATIVE-32xCPU-384GB |
| 48 cores | 384 GB | 〃 | CLOUDNATIVE-48xCPU-384GB |
| 64 cores | 384 GB | 〃 | CLOUDNATIVE-64xCPU-384GB |
| 48 cores | 512 GB | 〃 | CLOUDNATIVE-48xCPU-512GB |
| 64 cores | 512 GB | 〃 | CLOUDNATIVE-64xCPU-512GB |
| 80 cores | 512 GB | 〃 | CLOUDNATIVE-80xCPU-512GB |

At least one storage device is required for the Cloud Server to operate. Cloud Native plans can be used with a block storage device of any size and from any available [storage tier](/docs/products/block-storage/tiers.md).

## Common features across plans

All plans include a versatile range of server resources for varying use cases. While the resource configurations differ between each plan type, they all enjoy many of the same benefits.

**Billing per hour with a fixed monthly price**
Cloud Servers are priced by fixed monthly costs but billed per hour. This allows users to run cloud servers at a predictable monthly cost, but also deploy and delete short-term instances only paying for the hours used.

Cloud Servers are billed hourly and capped at 672 hours (24 h x 28 days) per month. This is done to ensure the monthly costs are the same every month regardless of the number of days in each month.

**What is included**

| Plan type | CPU & Memory | Block storage | IP addresses |
| --- | --- | --- | --- |
| Developer | Included | Standard | 1 public IPv4 |
| General Purpose | Included | MaxIOPS | 1 public IPv4 |
| High CPU | Included | MaxIOPS | 1 public IPv4 |
| High Memory | Included | MaxIOPS | 1 public IPv4 |
| Cloud Native | Included | Add-on | Add-on |

**What are billed separately**
Besides the essentials, we also offer additional services such as backups, firewalls, floating IPs, and SDN Private Networking. These additional services and usages exceeding plan allowances, such as extra storage or additional IPv4 addresses, are billed hourly for their usage according to our [listed pricing](https://upcloud.com/pricing/).

**How Cloud Servers plans are billed when shut down**
Developer, General Purpose, High CPU and High Memory plan Cloud Servers are billed per hour regardless of whether the server is powered on or shut down. This is due to the discounted bundle pricing which in turn affords a lower monthly cost. Cloud Native plans are only billed when powered.

**Trial limitations**
We offer a 7-day free trial to new users which is intended to allow getting familiar with our services and test Cloud Server deployments without commitment. As such, the trial has some limitations. Please refer to our [Free trial](/docs/getting-started/free-trial.md) documentation for the detailed breakdown of these.

When the free trial expires, user-created resources are deleted. Users are able to continue using the service and retain all resources created during the trial by making a one-time minimum deposit to their account.

## Discontinued plans

- [Flexible plans](/docs/products/cloud-servers/configurations/flexible-plans.md)

MaxIOPS is a registered trademark of UpCloud Ltd.
