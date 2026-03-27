# Kubernetes v1.28 now available

March 8, 2024
·
[Permalink](/docs/changelog/2024-03-08-kubernetes-1.28.md)

![kubernetes](media/image.png)

We're thrilled to announce that Kubernetes 1.28 is now available on UpCloud's Managed Kubernetes service. This latest update brings a range of enhancements and features that will empower you to manage your Kubernetes clusters with greater flexibility, resilience, and efficiency.

What's new in Kubernetes 1.28:

- Expanded supported skew between control plane and node versions: Kubernetes 1.28 extends the supported skew between core node and control plane components from n-2 to n-3, providing more flexibility in managing node upgrades.
- Recovery from non-graceful node shutdown: The ability to recover from non-graceful node shutdowns is now a stable feature, ensuring improved resilience and minimising the impact of node failures.
- Changes to console output in Kubernetes clusters: The kube-apiserver no longer returns formatted text responses when requests are made to /logs/, /portforward/, /exec/, or /debug/, simplifying the development of clients and tools.
- Updates to persistent volume deletion behavior: When the PersistentVolumeClaimDeletePoilcy feature gate is enabled, the DeleteClaim reclaim policy now removes the persistent volume claim (PVC) and persistent volume (PV) in the background asynchronously.
- Enhancement to the HPA API: The v2 autoscaling API now supports pod prioritisation, enabling custom pod ranking to determine which pods to scale down first during resource contention.
- Updates to the container runtime interface (CRI): CRI now supports four new features: multi-container pods, exec probe timeouts, named ports, and container image registry configuration.
- and more ...

To explore the complete set of features and improvements in Kubernetes 1.28, please refer to the official Kubernetes release notes: <https://kubernetes.io/docs/setup/release/notes/>

You can leverage Kubernetes 1.28 on UpCloud's Managed Kubernetes service by deploying a new cluster in the [UpCloud control panel](https://hub.upcloud.com/kubernetes/new).
