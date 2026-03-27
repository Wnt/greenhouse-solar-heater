# Managed Kubernetes Billing

## Control Plane

Control Plane is billed based on the user’s chosen plan – either the Development Plan or the Production Plan, depending on the cluster:

**Development plan**

- Clusters with up to 30 nodes
- No high availability
- Free of charge

**Production plan**

- Clusters with up to 120 nodes
- High Availability
- Billed per hour

Please see the [Managed Kubernetes pricing](https://upcloud.com/pricing/#managed-kubernetes) for costs in your currency.

## Data plane

Data Plane is billed by the Worker node according to the selected configuration.

Worker nodes can be deployed using any General Purpose, High CPU, High Memory or Cloud Native Cloud Server plans. Please refer to our [Cloud Server pricing](https://upcloud.com/pricing/#cloud-servers) for detailed node costs.

Kubernetes is a registered trademark of The Linux Foundation.
