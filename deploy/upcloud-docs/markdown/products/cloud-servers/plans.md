# Cloud Server plans

UpCloud offers a variety of Cloud Server plans tailored to different needs and use cases. This guide helps you understand the different plans and choose the best option for your requirements.

## Developer Plans

These plans are designed with a low price in mind, but still delivering good performance for running small scale projects, testing and developing.

**Use cases:** Optimised for experimentation, learning, and small-scale projects with moderate traffic.

Balanced CPU, memory, and storage resources. Developer plans use [Standard tier Block Storage](/docs/products/block-storage/tiers.md), which offers a good compromise on price over performance. Developer plans offer affordable pricing with predictable monthly costs.

**When to choose:**
When affordability and ease of use are primary concerns.
When you need a balanced server configuration for general-purpose tasks.
When you prefer predictable monthly billing.

**Reconsider if:** For business-critical workloads, consider using General Purpose or Cloud Native plans for better performance and higher 99.999% SLA.

## General Purpose Plans

General Purpose plans offer versatile resources for a wide range of applications. These plans have been designed for high performance in production workloads and business-critical applications.

General Purpose plans include the outstanding 99.999% SLA and a free 24 hour backup for the included storage. General Purpose plans utilize high performance [MaxIOPS block storage](/docs/products/block-storage/tiers.md).

*High CPU* and *High Memory* options offer more resources for CPU and memory intensive applications, such as high performance transactions, or persistent and in-memory databases.

**Use cases:** Optimised for anything business-critical, be it web servers and application hosting, databases or data analytics, or any other hosting need. When you prefer predictable monthly billing.

**Reconsider if:** If your use case doesn't require public IP addresses and a large amount of public storage, Cloud Native plans might be a better option.

## Cloud Native Plans

Cloud Native plans unbundle storage and IP addresses from the server plan, and work best in cloud-native setups where Cloud Servers are connected to SDN Private Networks and individual storage devices are attached only as required. Cloud Native plans work especially well as Managed Kubernetes worker nodes. With Cloud Native plans, only CPU and memory and network traffic comes with the server plan, everything else is bought as extra.

**Use cases:** Optimised for the best possible unit price without paying for ununsed resources. For cloud-native setups, especially for Kubernetes worker nodes. For automatically scaling setups without need for public IP connectivity or bundled storage.

**Reconsider if:** For stable workloads with a large amount of bundled resources, such as ample included storage space, consider using General Purpose plans instead.

## Pricing

Cloud Servers are billed by the hour. Refer to [Pricing](https://upcloud.com/pricing/#cloud-servers) for more details about the pricing models for different plans.

## Considerations for choosing a Cloud Server plan

Consider the following factors when selecting a Cloud Server plan:

**Workload requirements:** CPU, memory and storage needs. Developer plans offer good options for small use cases, while General Purpose and Cloud Native plans have a wider support for resources.

**Application type:** Web server, database, application hosting, etc. Your application requirements dictate whether the workload is bottlenecked first by CPU or memory.

**Scalability needs:** Ability to scale resources up or down as needed. For best scalability, deploy auto scaling servers with Cloud Native plans.

**Budget:** All plans come with a clear capped monthly price, but are billed by the hour.

**Isolation and commitment:** Consider [Private Cloud services](/docs/products/private-cloud.md) for stable workloads and more isolation than on the public cloud.

If you're unsure which plan is right for you, contact UpCloud support for assistance.
