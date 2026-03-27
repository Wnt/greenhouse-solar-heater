# Managed Kubernetes Data Plane

The Kubernetes® data plane is composed of cluster's worker nodes. With UpCloud's Managed Kubernetes, worker nodes are deployed through cluster node groups. These nodes run customer workloads and are managed by the control plane.

## Node groups

Users have full control of their data plane configuration, allowing them to arrange worker nodes in groups with varying Cloud Server plans.

Node groups can be configured to use any pre-defined Cloud Server plan. For more information, see [Cloud Server configurations](/docs/products/cloud-servers/configurations.md) for more details.

Node groups can be scaled horizontally by adding or removing nodes.

## Anti-affinity

When creating a new node group, users have the option to select Anti-affinity in the Advanced settings. If enabled, nodes in this group are aimed to be placed on separate compute hosts.

Please note that the anti-affinity policy is considered a “best effort” and enabling it does not fully guarantee that the nodes will end up on different hardware.

## Network connectivity

UpCloud's Managed Kubernetes is pre-configured with and optimised to use Cilium as the Container Networking Interface (CNI) plugin.

Data plane worker nodes are connected via Private networks made available in the same zone as the Managed Kubernetes cluster.

Requirements are:

- One Private network per Kubernetes cluster is required.
- Only one cluster can be connected to any one Private network at the same time.
- The Private network cannot be changed after cluster creation.

## Network CIDR ranges

When creating the cluster, please make sure your network configuration does not overlap with the following CIDR ranges:

- Control Plane CIDR: `172.31.240.0/24`
- Service CIDR: `10.128.0.0/12`
- POD CIDR: `192.168.0.0/16`
- Forwarder CIDR: `10.33.128.0/22`
- Load Balancer CIDR: `100.64.0.0/10` (Used for Load Balancer assignment)
- Utility CIDR (per cluster zone):
  - fi-hel1: `10.1.0.0/16`
  - uk-lon1: `10.2.0.0/16`
  - us-chi1: `10.3.0.0/16`
  - de-fra1: `10.4.0.0/16`
  - nl-ams1: `10.5.0.0/16`
  - fi-hel2: `10.6.0.0/16`
  - es-mad1: `10.7.0.0/16`
  - us-sjo1: `10.8.0.0/16`
  - us-nyc1: `10.9.0.0/16`
  - sg-sin1: `10.10.0.0/16`
  - pl-waw1: `10.11.0.0/16`
  - au-syd1: `10.12.0.0/16`
  - se-sto1: `10.13.0.0/16`
  - dk-cph1: `10.14.0.0/16`
  - no-svg1: `10.15.0.0/16`

## Private node groups

Optionally, cluster can be created by assigning only private IP addresses to the cluster worker nodes. Cluster nodes are then not accessible from the Internet and all services have to be exposed through a Load Balancer.

The worker nodes require Internet access to operate correctly. As a requirement, the selected SDN network has to have a SDN router and a NAT Gateway configured. See [NAT Gateways](/docs/products/nat-gateway.md) for more information.

## Accessing worker nodes over SSH

Node groups support the use of SSH keys for accessing worker nodes. These can be configured in the Advanced settings, only upon node group creation. Note that SSH keys are not configured by default.

Kubernetes is a registered trademark of The Linux Foundation.
