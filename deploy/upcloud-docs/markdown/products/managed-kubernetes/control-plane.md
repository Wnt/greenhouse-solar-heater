# Managed Kubernetes Control Plane

UpCloud’s Managed Kubernetes manages the specialised Kubernetes® control plane components which make global decisions about cluster scheduling and deployments.

The control plane runs on fully managed cloud infrastructure according to the selected configuration plan. Users have the option to choose between the Development and Production plans depending on their use case.

## Development plan

The Development plan is ideal for development, proof of concepts and small hobby projects with up to 30 data plane nodes and a few hundred pods, depending on the nature of the workloads.

## Production plan

For production use or clusters larger than 50 worker nodes, it is advised to use the Production plan. Production plans are assigned more CPU and memory resources, which in turn allows them to handle clusters of up to 120 data plane nodes and thousands of pods, depending on the workloads.

## Limiting Kubernetes API access

Each cluster is configurable with an IP filter for API access. The filter controls which source IP addresses or ranges can interact with the cluster’s core management interface, the Kubernetes API. This access is necessary for the use of the “kubectl” tool.

The IP filter does not impact the accessibility of exposed services or worker nodes, as these components are not managed through the Kubernetes API. The list of allowed source IP addresses/ranges is modifiable after cluster creation.

It is also possible to allow access from the public Internet to the Kubernetes API.

Kubernetes is a registered trademark of The Linux Foundation.
