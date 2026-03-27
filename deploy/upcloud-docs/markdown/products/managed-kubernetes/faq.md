# Managed Kubernetes FAQ

## Setup

**I'm new to Kubernetes, how do I get started?**

Check out [our guide](/docs/guides/get-started-managed-kubernetes.md) for more information and how create your first Managed Kubernetes cluster.

**How are worker nodes deployed? Which zone will host the data plane?**

Worker nodes are deployed to the same zone as the cluster is located in.

**Is Private Cloud supported?**

Yes, see [UpCloud Managed Kubernetes in Private Cloud](/docs/products/managed-kubernetes/private-cloud.md).

**Can I connect my Kubernetes cluster with other managed services such as Managed Databases?**

Yes, this can be accomplished easily via the Utility network.

**Can I use Tailscale or other mesh VPNs with Managed Kubernetes?**

Yes, but you may encounter IP range conflicts or routing issues due to our default network configuration.

1. IP range conflict:
   UpCloud Load Balancers use the `100.64.0.0/10` CGNAT range. By default, Tailscale also uses this range. Configure Tailscale to use a non-overlapping IP pool. See [Network CIDR ranges](/docs/products/managed-kubernetes/data-plane#network-cidr-ranges.md).
2. Cilium compatibility:
   UpCloud uses Cilium with kube-proxy-replacement enabled. This can conflict with the Tailscale Kubernetes operator. Enable hostNamespaceOnly mode for socket load balancing in the Cilium configuration.

## Operations

**Which Kubernetes versions are supported?**

See documentation on [supported versions](/docs/products/managed-kubernetes/supported-versions.md).

**Can I upgrade my Kubernetes cluster to a newer version?**

Yes, you can upgrade your Kubernetes cluster to a newer version. Upgrading to version 1.30 from any earlier version requires a manual process, using tools like Velero for backup and restore. This [guide](/docs/guides/migration-uks-velero.md) describes how to do that. For upgrades starting from version 1.30, you can upgrade one minor version at a time (e.g., 1.30 to 1.31) by manually cycling nodes or using an automatic rolling update.

**Can I use applications such as Helm charts? Any other tools that are available for management and configuration?**

You can use Helm with Managed Kubernetes. Customers are free to decide to use the tool that fits best to their development needs. Many use ArgoCD to manage deployments in Managed Kubernetes.

**Can I use CiliumNetworkPolicy objects to restrict network traffic?**

Yes, you can.

For UKS 1.29 and Cilium 1.16.1 specifically, you will need to change `k8s-service-proxy-name: "cilium"` to `k8s-service-proxy-name: ""` in your Cilium configuration. Steps to modify:

- Edit and save the `cilium-config` configmap: `kubectl edit cm -n kube-system cilium-config`
- Restart Cilium pods: `kubectl rollout restart ds/cilium -n kube-system`

Note that after this change the cluster will no longer pass CNCF conformance tests. The following test will fail:

> [sig-network] Services should serve endpoints on same port and different protocols [Conformance]

Consider whether this is an issue in your environment. The issue will be fixed in Cilium 1.17, once released.

Kubernetes is a registered trademark of The Linux Foundation.
