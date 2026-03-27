# Managed Kubernetes Autoscaling

Cluster Autoscaler is an additional component of the UpCloud Kubernetes service, automatically adjusting the size of your Kubernetes cluster to optimize resource utilization and cost-efficiency.

The Cluster Autoscaler monitors the resource demands of your workloads and automatically scales the number of nodes in your cluster up or down as needed. This ensures that your applications have the resources they require while avoiding unnecessary costs from idle nodes.

The Cluster Autoscaler works in tandem with the Kubernetes Horizontal Pod Autoscaler (HPA). While HPA scales the number of pods in a deployment or replication controller, the Cluster Autoscaler ensures there are enough nodes to accommodate these pods. If HPA scales up pods and there aren't enough resources in the existing nodes, the Cluster Autoscaler will add new nodes to meet the demand.

The implementation is based on the Kubernetes Cluster Autoscaler project and [available in GitHub](https://github.com/UpCloudLtd/autoscaler).

## Getting started

Cluster Autoscaler has to be configured & installed on UpCloud's Kubernetes Service.

See the [Cluster Autoscaler guide](/docs/guides/cluster-autoscaler.md) to get started!

## Deployment considerations

The Cluster Autoscaler cannot scale the control plane nodes in UpCloud's Kubernetes Service.

Scaling the cluster to zero nodes is not possible as the component is run on data plane nodes. Individual node groups can be scaled to zero. It is possible to define minimum and maximum sizes for node groups through the `--nodes`. See documentation about all available [parameters](https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md#what-are-the-parameters-to-ca).

## Share your feedback

Please reach out to us through [GitHub issues](https://github.com/UpCloudLtd/autoscaler/issues). We would love to hear your feedback!

Kubernetes is a registered trademark of The Linux Foundation.
