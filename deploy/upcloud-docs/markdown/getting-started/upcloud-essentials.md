# UpCloud Essentials

UpCloud Essentials provides a set of complimentary cloud features available to all UpCloud customers. Unlike the free trial, which lasts for 7 days, Essentials features are permanently available as part of the standard UpCloud platform.

## Included features

UpCloud Essentials includes the following services and features at no additional cost:

| Feature / Service | Complimentary tier details |
| --- | --- |
| Managed Load Balancer | 1 Node, up to 1000 sessions |
| Managed Kubernetes | Control Plane management for clusters with up to 30 worker nodes |
| NAT & VPN Gateway | 1 node, up to 1 tunnel, 500 Mbps bandwidth, 10,000 max connected clients |
| Zero data transfer fees | Subject to our Fair Transfer Policy |
| API & SDKs | Full access to automate and integrate UpCloud services |
| Hot resize | Scale Cloud Server resources (CPU/Memory) without downtime on compatible plans |
| Global private network | Private connectivity between Cloud Servers across all data centers |
| 24/7 technical support | Access to support team |

## Using UpCloud Essentials

No separate activation is required for UpCloud Essentials. The complimentary features are automatically available when you use the corresponding UpCloud products.

When configuring services like Managed Kubernetes, Managed Load Balancer, or NAT/VPN Gateway, select the available free tier (such as the "Development" plan) during setup to use the Essentials offering.

Features like zero data transfer fees, API access, hot resize, and the global private network are included by default with relevant services.

## Resource requirements

UpCloud Essentials features are components of the overall UpCloud platform. You will still need underlying resources like [Cloud Servers](/docs/products/cloud-servers.md) and [Storage](/docs/products/block-storage.md) to build your infrastructure. These resources are billed according to their respective plans.

## Account quotas

You can deploy up to 5 instances of the following Essentials services per account:

- Up to 5 Managed Load Balancers
- Up to 5 NAT & VPN Gateways combined (eg, 2 NAT Gateways and 3 VPN Gateways)

Managed Kubernetes clusters do not have an account limit within the Essentials tier.

Each deployed instance is still subject to the individual service limits described in the [table above](/docs/getting-started/upcloud-essentials#included-features.md). For example, each of your five Load Balancers would be limited to 1 node and 1000 sessions unless upgraded to a paid plan.

Please note that provisioning of any service, including those within Essentials tiers, is subject to overall resource availability in the chosen data center.

## Upgrading

To use more resources than the free tier allows, you must manually upgrade the service to a paid plan that fits your needs. You can do this in the [UpCloud Control Panel](https://hub.upcloud.com/) or using the API.

1. Navigate to the specific service in the [UpCloud Control Panel](https://hub.upcloud.com/)
2. Select a paid plan that meets your requirements
3. Confirm the change to upgrade from the free tier

Once upgraded to a paid plan, you will be billed the standard price for the chosen plan. Details on paid plans, their limits, and costs can be found on the [Pricing Page](https://upcloud.com/pricing/).
