# Managed Kubernetes Encrypted Clusters

UpCloud's Managed Kubernetes includes encryption-at-rest support for involved storage persistence
layers. Users can enable storage encryption in cluster, node group or Persistent Volume basis.

Enabling encryption-at-rest affects storage performance. See [encryption-at-rest documentation for more information](/docs/products/block-storage/encryption-at-rest.md).

This feature is currently only available over Terraform and API.

## Cluster encryption

Cluster-level encryption can only be enabled upon cluster creation. All persistent storage in the
cluster control plane will have encryption-at-rest enabled. Subsequently, all node groups
and Persistent Volumes have encryption-at-rest enabled. Users can opt out of the two by
explicitly creating non-encrypted resources, meaning node groups with encryption disabled and
Persistent Volumes with a non-default storage class (such as `upcloud-block-storage-maxiops`).

Use `storage_encryption` parameter for `upcloud_kubernetes_cluster` resource in Terraform. See [Terraform provider documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs/resources/kubernetes_cluster#storage_encryption) for more information.

## Node group encryption

For existing clusters, users can opt-in to node-group level encryption by creating a new node group
with encryption enabled. This allows mix and matching node groups with varying levels of
encryption requirements, on a per-workload basis.

Use `storage_encryption` parameter for `upcloud_kubernetes_node_group` resource in Terraform. See [Terraform provider documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs/resources/kubernetes_node_group#storage_encryption) for more information.

## Persistent Volume encryption

The UpCloud CSI driver introduces a storage class `upcloud-block-storage-maxiops-encrypted`.

See [CSI driver storage encryption guide](/docs/guides/storage-encryption-at-rest.md) for more information.
