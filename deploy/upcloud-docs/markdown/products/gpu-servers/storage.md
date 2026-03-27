# Storage on GPU Servers

UpCloud GPU Servers support flexible and high-performance storage options through block storage devices. Block storage can be attached to a GPU Server either during the initial deployment or at any time afterwards, allowing you to scale your storage as your needs grow.

## Storage tiers

You can choose from any available [storage tier](/docs/products/block-storage/tiers.md) for your GPU Server:

- **MaxIOPS:** Recommended for low-latency, high-performance workloads such as AI/ML training, data analytics, and scientific computing.
- **Standard:** Suitable for general-purpose storage needs.
- **Archive:** Ideal for infrequently accessed data or backups.

All data stored on block storage is persistent, meaning it remains available even if the server is stopped or deleted.

## Attaching and managing storage

- **Attach at deployment:** Select the desired storage tier and size when creating your GPU Server.
- **Attach later:** Add additional storage devices to your existing GPU Server at any time via the UpCloud Control Panel.
- **Multiple devices:** You can attach multiple block storage devices to a single GPU Server, providing flexibility for separating data, workloads, or backups.
- **Expand storage:** Increase the size of your storage devices as your data requirements grow.

## Moving storage between servers

Block storage devices can be detached from one GPU Server and attached to another server within the same data center location. This makes it easy to migrate data or reassign storage resources as needed.

## Best practices

- Use MaxIOPS storage for workloads that require high throughput and low latency.
- Regularly back up important data using snapshots or by attaching additional storage for backups.
- Monitor your storage usage and performance to ensure your GPU Server continues to meet your workload requirements.

For detailed instructions on adding, removing, or resizing storage devices, see the [Adding and removing storage devices guide](/docs/guides/adding-removing-storage-devices.md).
