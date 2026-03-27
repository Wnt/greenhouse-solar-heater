# Managing GPU Servers

UpCloud GPU Servers are designed to provide dedicated GPU resources for your workloads, while maintaining the flexibility and manageability of regular cloud servers. This section covers key aspects of managing your GPU Servers, including GPU access, monitoring, and best practices.

## GPU access and passthrough

GPUs are exposed to cloud servers as PCIe passthrough devices. This means your server has direct, exclusive access to the physical GPU, allowing you to utilize its full capabilities for compute, AI/ML, or graphics workloads. The GPU is not shared with other customers - each GPU is always dedicated to a single server.

## Server management

In all other aspects, GPU Servers function just like regular UpCloud Cloud Servers:

- **Storage:** Attach, detach, and resize block storage volumes as needed. All storage tiers are supported.
- **Networking:** Configure private and public networking, firewalls, and floating IPs as you would with any other server.
- **Backups and Snapshots:** Create backups and snapshots to protect your data and enable easy recovery.
- **Resizing:** You can resize your server's CPU, RAM, GPU and storage resources.

## Monitoring and tools

- **nvidia-smi:** Use the `nvidia-smi` command-line tool to monitor GPU status, utilization, and driver versions. This tool is included with the NVIDIA® driver installation and is essential for verifying that your GPU is recognized and functioning correctly.
- **System Monitoring:** Standard Linux tools (such as `htop`, `free`, and `df`) can be used to monitor CPU, memory, and storage usage.

## Best practices

- **Use the Ubuntu GPU template:** For the best out-of-the-box experience, deploy your GPU Server using the AI/ML-ready GPU Ubuntu template. This template includes [pre-installed NVIDIA drivers and common libraries](/docs/products/gpu-servers/software#operating-system-options.md), reducing setup time and compatibility issues.
- **Keep software updated:** Regularly update your operating system, GPU drivers, and CUDA toolkit to benefit from the latest features, performance improvements, and security patches.
- **Back up regularly:** Use UpCloud's snapshot backup features to protect your data and configurations.
- **Test GPU functionality:** After deployment or driver updates, always verify GPU availability and health with `nvidia-smi`.

## Additional resources

- [Recommended software for GPU Servers](/docs/products/gpu-servers/software.md)
- [Adding and removing storage devices](/docs/guides/adding-removing-storage-devices.md)

NVIDIA is a registed trademark of NVIDIA Corporation.
