# Cloud Server System Architecture

UpCloud is built on the principles of speed and reliability by employing the latest technologies and hardware. Our infrastructure provides enterprise-grade performance, security, and reliability for all cloud computing needs.

## Cloud Server hosts

UpCloud's infrastructure is designed from the ground up with high availability in mind. Cloud Servers operate on dedicated compute hosts, where:

- All mission-critical components have N+1 redundancy
- Dual network connections ensure continuous connectivity
- Error-corrected memory modules prevent data corruption
- Real-time monitoring ensures optimal performance

Block storage is provided from an equally highly available and fault-tolerant [storage system](/docs/products/block-storage/storage-system.md), designed for enterprise workloads.

## Automated failover

Our automated failover system ensures business continuity:

- Instant detection of compute host failures
- Automatic transfer of Cloud Servers to healthy hosts
- Live migration capability with minimal downtime (typically just seconds)
- No data loss during transfers

## Virtualisation

We employ the Linux® Kernel-based Virtual Machine (KVM) virtualisation module, which offers:

- Hardware-assisted virtualisation for optimal performance
- Bare-metal level speed for virtual machines
- Strong isolation between instances
- Proven security track record
- Extensive enterprise adoption

## CPUs

Our commitment to performance includes:

- Top-of-the-range enterprise hardware in all data centres
- High-powered enterprise-grade processors
- Latest generation AMD EPYC processors
- Optimized CPU-to-memory ratios
- Regular hardware refresh cycles

## Automated balancing

Our sophisticated cloud orchestration system:

- Continuously monitors host utilization
- Optimizes resource distribution in data centres
- Automatically selects the least-used hosts for new deployments
- Rebalances workloads on server restart
- Enables manual performance optimization through server restart

Linux is the registered trademark of Linus Torvalds in the U.S. and other countries.
