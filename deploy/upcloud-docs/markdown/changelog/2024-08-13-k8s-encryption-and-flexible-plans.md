# Encryption and flexible plan support for UKS

August 13, 2024
·
[Permalink](/docs/changelog/2024-08-13-k8s-encryption-and-flexible-plans.md)

UpCloud Managed Kubernetes now supports encryption-at-rest with various configurations. Users can
define encryption on cluster level, node group level and per Persistent Volume. Learn more from the [encrypted clusters documentation](/docs/products/managed-kubernetes/encrypted-clusters.md).

We have also added support for flexible plans in cluster node groups. Read more from the Terraform `upcloud_kubernetes_node_group` [resource documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs/resources/kubernetes_node_group#nested-schema-for-custom_plan).
