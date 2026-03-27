# GPU Server configurations

GPU Servers are provisioned by choosing a server plan, which defines the amount of CPU, memory and number of GPUs.

## GPU Servers with NVIDIA L40S

GPU Server plans include CPU cores, memory and NVIDIA® L40S GPU(s).

Each server must have at least one block storage device for the operating system. Block storage devices can be of any size (1 GB - 4 TB each) and from any [storage tier](/docs/products/block-storage/tiers.md).

IPv4s can be added at additional cost when necessary.

**Plans include**

- CPU & Memory & GPUs
- 99.999% SLA
- Billed only when server is started

**Add-ons**

- Block storage ([any tier](/docs/products/block-storage/tiers.md))
- Public IP addresses
- Backup options

| CPU cores | RAM | GPU | Identifier |
| --- | --- | --- | --- |
| 8 cores | 64 GB | 1 x NVIDIA L40S | GPU-8xCPU-64GB-1xL40S |
| 12 cores | 128 GB | 1 x NVIDIA L40S | GPU-12xCPU-128GB-1xL40S |
| 12 cores | 128 GB | 2 x NVIDIA L40S | GPU-12xCPU-128GB-1xL40S |
| 16 cores | 192 GB | 1 x NVIDIA L40S | GPU-16xCPU-192GB-1xL40S |
| 16 cores | 192 GB | 2 x NVIDIA L40S | GPU-16xCPU-192GB-2xL40S |
| 16 cores | 192 GB | 3 x NVIDIA L40S | GPU-16xCPU-192GB-3xL40S |
| 20 cores | 256 GB | 1 x NVIDIA L40S | GPU-20xCPU-256GB-1xL40S |
| 20 cores | 256 GB | 2 x NVIDIA L40S | GPU-20xCPU-256GB-2xL40S |
| 20 cores | 256 GB | 3 x NVIDIA L40S | GPU-20xCPU-256GB-3xL40S |
| 32 cores | 384 GB | 2 x NVIDIA L40S | GPU-32xCPU-384GB-2xL40S |
| 32 cores | 384 GB | 3 x NVIDIA L40S | GPU-32xCPU-384GB-3xL40S |

**How GPU Servers are billed when shut down**
GPU Server plans are only billed when the server is powered on. However, attached block storages and public IPv4 addresses are reserved and thus billed even when the server is shut down.

**Trial limitations**
We offer a 7-day free trial to new users which is intended to allow getting familiar with our services and test Cloud Server deployments and managed services without commitment. GPU Servers are not included as part of the trial. If you have specific requirements to try GPU Servers, please [contact us](https://upcloud.com/contact/).

NVIDIA is a registered trademark of NVIDIA Corporation.
