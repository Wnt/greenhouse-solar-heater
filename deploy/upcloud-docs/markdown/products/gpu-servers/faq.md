# GPU Servers FAQ

## Billing and resources

**Does a GPU Server incur charges when stopped?**

No, you are not billed for the server itself when it is stopped. However, any attached storage volumes and allocated public IP addresses will continue to incur charges until they are deleted or released.

**Can I attach additional storage to my GPU Server?**

Yes, you can attach, detach, and resize block storage volumes to your GPU Server at any time. All storage tiers are supported, and you can manage storage through the UpCloud Control Panel or API.

**What happens to my data if I delete a GPU Server?**

When you delete a GPU Server, any attached storage volumes that are not deleted will remain in your account and continue to incur charges. Be sure to back up important data and manage your storage resources accordingly.

## Hardware and performance

**How do multi-GPU servers work?**

Multi-GPU servers are equipped with more than one dedicated GPU. All GPUs are exposed to your cloud server via PCIe passthrough, allowing you to utilize them for parallel processing, distributed training, or other multi-GPU workloads. You can verify the available GPUs using the `nvidia-smi` tool.

**Is GPU passthrough exclusive to my server?**

Yes, each GPU is dedicated to a single server and is not shared with other customers. This ensures consistent performance and security for your workloads.

**How do I monitor GPU usage and health?**

You can use the `nvidia-smi` command-line tool to monitor GPU status, utilization, temperature, and driver versions. Additional monitoring can be set up using standard Linux tools and third-party solutions.

## Software and tooling

**What operating systems are supported on GPU Servers?**

You can deploy any supported public template, including various Linux distributions and Windows Server images. For the best experience, we recommend using the AI/ML-ready GPU Ubuntu template, which comes pre-installed with NVIDIA drivers and common GPU libraries. See [Recommended software](/docs/products/gpu-servers/software.md).

**Do I need to install NVIDIA drivers myself?**

If you use the AI/ML-ready GPU Ubuntu template, the necessary NVIDIA drivers are pre-installed. If you choose another operating system, you will need to manually install the appropriate NVIDIA drivers and CUDA toolkit to enable GPU functionality.

**Can I use Docker with GPU Servers?**

Yes, you can run containerized workloads on GPU Servers. Docker and the NVIDIA Container Toolkit are included in the Ubuntu template GPU Servers. This allows you to run GPU-accelerated containers for AI/ML and other workloads.
