# UKS Shared Responsibility

UpCloud’s Managed Kubernetes Service (UKS) follows a shared responsibility model that clearly delineates which tasks are handled by UpCloud and which are the customer’s responsibility.

While not exhaustive, this guide addresses common questions about what UpCloud manages versus what customers are expected to handle.

In general, UKS manages the [**control plane**](https://kubernetes.io/docs/concepts/overview/components/#control-plane-components), while customers are responsible for the [**data plane**](https://kubernetes.io/docs/concepts/overview/components/#node-components). Upon cluster creation, UKS bootstraps the data plane, but node groups and nodes are provisioned according to customer specifications. UKS does not modify, update, or configure the data plane after creation. As such, customers are responsible for managing, updating, and configuring all visible components within the data plane.

The diagram below illustrates the shared responsibility model.

![UKS shared responsibility layers](uks-shared-resposibilities.jpg)

**Important Notes:**

- **Privacy Policy:** As a policy, UpCloud will never take actions on your deployments or workloads. You retain full control over the deployments in your data plane.
- **Isolation Policy:** As a policy, UpCloud will not take actions within your data plane nodes, other than when strictly necessary and explicitly requested by you —Kubernetes version upgrades being one clear example.
- **Responsibility:** Customers are responsible for the security, configuration, and ongoing maintenance of their deployments.
- **New data plane nodes are provisioned with the following defaults:**

  - **CSI:** The [UpCloud CSI](https://github.com/UpCloudLtd/upcloud-csi) driver for persistent storage support.
  - **CNI:** [Cilium](https://github.com/cilium/cilium) is installed by default. We **strongly** advice against attempting to modify, reconfigure it or replace it in any way, as this could render the cluster unusable.
  - **Konnectivity:** A [Konnectivity](https://kubernetes.io/docs/concepts/architecture/control-plane-node-communication/#konnectivity-service) agent is pre-installed to provide communication with the control plane. We **strongly** advice against attempting to modify or replace this component, as it may impact cluster stability.
  - **Kubelet:** Comes with default configuration values, including sensible [eviction thresholds](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/#eviction-thresholds). You can override these settings by providing custom arguments when creating a node group using the `kubelet_args` [input parameter](https://developers.upcloud.com/1.3/20-managed-kubernetes/#kubelet-argument).
  - **CoreDNS:** The cluster includes a pre-configured [CoreDNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/) deployment for internal service discovery. While you may customize its configuration, this is an advanced feature and changes should be made carefully to avoid breaking name resolution within the cluster.
