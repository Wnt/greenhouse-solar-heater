# Managed Kubernetes GPU Nodes

UpCloud Managed Kubernetes supports GPU node groups to accelerate AI, machine learning, and compute-intensive workloads. GPU nodes come with NVIDIA drivers pre-installed and GPU resources exposed to the container runtime:

- **NVIDIA Driver**: Version 580
- **CUDA**: Version 12.6
- **NVIDIA Container Toolkit**: Pre-configured for container runtime integration

## Getting started

GPU node groups can be added to your cluster through the [API](/docs/guides/getting-started-upcloud-api.md), [Terraform](/docs/guides/get-started-terraform.md), OpenTofu or [upctl](/docs/guides/get-started-upcloud-command-line-interface.md). GPUs are automatically available to all containers running on GPU nodes. To use Kubernetes resource limits (`nvidia.com/gpu`) for GPU scheduling, the NVIDIA device plugin must be installed separately.

See the [Getting Started with GPU Workloads in Managed Kubernetes guide](/docs/guides/gpu-workloads-managed-kubernetes.md) for setup instructions.
