# GPU Server configurations

GPU Servers are provisioned by choosing a server plan, which defines the amount of CPU, memory and number of GPUs.

## GPU Server configurations

A GPU Server configuration includes CPU cores, memory and access to one or multiple GPU accelerators.

In addition, each server must have at least one block storage device for the operating system. Block storage devices can be of any size (1 GB - 4 TB each) and from any [storage tier](/docs/products/block-storage/tiers.md).

IPv4s can be added at additional cost if necessary.

## Choosing the right GPU

|  | NVIDIA L4 | NVIDIA L40S | NVIDIA H100 | NVIDIA B200 |
| --- | --- | --- | --- | --- |
| Use case | Image generation, speech-to-text, basic inference. | Video, graphics, 3D rendering, intensive inference. | High-traffic inference, massive batch processing and large-model training. | Trillion-parameter model inference, model training, running complex models in real-time. |
| GPU memory (VRAM) | 24 GB | 48 GB | 80 GB | 192 GB |
| Memory bandwidth | 300 GB/s | 864 GB/s | 3.35 TB/s | 8.0 TB/s |
| Performance (FP8) | 0.48 PFLOPS | 1.46 PFLOPS | 3.9 PFLOPS | 9.00 FLOPS |
|  |

## GPU Servers with NVIDIA L4

**Plans include**

- CPU & Memory & GPUs
- 99.999% SLA
- Billed only when server is started

**Add-ons**

- Block storage ([any tier](/docs/products/block-storage/tiers.md))
- Public IP addresses
- Backup options

CPU model: AMD EPYC 9575F

| CPU cores | RAM | GPU | Identifier |
| --- | --- | --- | --- |
| 8 cores | 64 GB | 1 x NVIDIA L4 | GPU-8xCPU-64GB-1xL4 |
| 12 cores | 128 GB | 1 x NVIDIA L4 | GPU-12xCPU-128GB-1xL4 |
| 12 cores | 128 GB | 2 x NVIDIA L4 | GPU-12xCPU-128GB-1xL4 |
| 16 cores | 192 GB | 1 x NVIDIA L4 | GPU-16xCPU-192GB-1xL4 |
| 16 cores | 192 GB | 2 x NVIDIA L4 | GPU-16xCPU-192GB-2xL4 |
| 16 cores | 192 GB | 3 x NVIDIA L4 | GPU-16xCPU-192GB-3xL4 |
| 20 cores | 256 GB | 1 x NVIDIA L4 | GPU-20xCPU-256GB-1xL4 |
| 20 cores | 256 GB | 2 x NVIDIA L4 | GPU-20xCPU-256GB-2xL4 |
| 20 cores | 256 GB | 3 x NVIDIA L4 | GPU-20xCPU-256GB-3xL4 |
| 32 cores | 384 GB | 2 x NVIDIA L4 | GPU-32xCPU-384GB-2xL4 |
| 32 cores | 384 GB | 3 x NVIDIA L4 | GPU-32xCPU-384GB-3xL4 |

## GPU Servers with NVIDIA L40S

**Plans include**

- CPU & Memory & GPUs
- 99.999% SLA
- Billed only when server is started

**Add-ons**

- Block storage ([any tier](/docs/products/block-storage/tiers.md))
- Public IP addresses
- Backup options

CPU model: AMD EPYC 9575F

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

## GPU Servers with NVIDIA H100

**Plans include**

- CPU & Memory & GPUs
- 99.999% SLA
- Billed only when server is started

**Add-ons**

- Block storage ([any tier](/docs/products/block-storage/tiers.md))
- Public IP addresses
- Backup options

CPU model: Intel Xeon Platinum 8462Y+

| CPU cores | RAM | GPU | Identifier |
| --- | --- | --- | --- |
| 12 cores | 240 GB | 1 x NVIDIA H100 | GPU-12xCPU-240GB-1xH100 |
| 24 cores | 480 GB | 2 x NVIDIA H100 | GPU-24xCPU-480GB-2xH100 |
| 48 cores | 960 GB | 4 x NVIDIA H100 | GPU-48xCPU-960GB-4xH100 |
| 96 cores | 1920 GB | 8 x NVIDIA H100 | GPU-96xCPU-1920GB-8xH100 |

**NVlink included**

H100 GPU Servers include NVIDIA NVlink technology for direct GPU-to-GPU communication. NVlink provides 900 GB/s of bidirectional bandwidth between GPUs, enabling highly efficient multi-GPU workloads, distributed training, and large-scale model inference without going through CPU memory.

## GPU Servers with NVIDIA B200

**Plans include**

- CPU & Memory & GPUs
- 99.999% SLA
- Billed only when server is started

**Add-ons**

- Block storage ([any tier](/docs/products/block-storage/tiers.md))
- Public IP addresses
- Backup options

CPU model: Intel Xeon Platinum 8570

| CPU cores | RAM | GPU | Identifier |
| --- | --- | --- | --- |
| 12 cores | 240 GB | 1 x NVIDIA B200 | GPU-12xCPU-240GB-1xB200 |
| 24 cores | 480 GB | 2 x NVIDIA B200 | GPU-24xCPU-480GB-2xB200 |
| 48 cores | 960 GB | 4 x NVIDIA B200 | GPU-48xCPU-960GB-4xB200 |
| 96 cores | 1920 GB | 8 x NVIDIA B200 | GPU-96xCPU-1920GB-8xB200 |

**NVlink included**

B200 GPU Servers include NVIDIA NVlink technology for direct GPU-to-GPU communication. NVlink provides 1800 GB/s of bidirectional bandwidth between GPUs, enabling highly efficient multi-GPU workloads, distributed training, and large-scale model inference without going through CPU memory.

**How GPU Servers are billed when shut down**
GPU Server plans are only billed when the server is powered on. However, attached block storages and public IPv4 addresses are reserved and thus billed even when the server is shut down.

**Trial limitations**
We offer a 7-day free trial to new users which is intended to allow getting familiar with our services and test Cloud Server deployments and managed services without commitment. GPU Servers are not included as part of the trial. If you have specific requirements to try GPU Servers, please [contact us](https://upcloud.com/contact/).

NVIDIA is a registered trademark of NVIDIA Corporation.
