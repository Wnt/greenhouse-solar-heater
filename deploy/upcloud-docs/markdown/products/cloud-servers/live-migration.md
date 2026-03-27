# Live migration of Cloud Servers

UpCloud uses live migration to seamlessly update its server, storage and networking infrastructure.

During a live migration, a running Cloud Server is moved from one physical host server to another without requiring the server to be rebooted. This ensures continuous availability and minimises downtime for your applications.

## Why live migrations happen

UpCloud conducts live migrations for various reasons, including:

- **Optimising resource distribution:** To prevent overload and ensure consistent performance, we rebalance server loads across our infrastructure. This avoids congestion of CPU, memory, storage and network resources.
- **Performing rolling updates:** Live migration enables us to upgrade the software and hardware of our host machines without affecting your Cloud Servers.

While users cannot manually initiate live migrations, this process is crucial for managing updates and maintaining a stable, high-performance cloud environment. If you need to move your server to a different host, you can simply stop and restart it. The restart process automatically selects the most suitable host based on your server's configuration and current resource usage.

Live migrations are performed only within the same data centre, and data is never transferred to another location without the user's specific intention. The source and target hosts must have compatible hardware to ensure a smooth transition.

## The live migration process

1. **Host selection:** A new host within the same data centre is selected based on the Cloud Server configuration and the current resource usage of available hosts.
2. **Server creation:** A new virtual machine, mirroring the Cloud Server's configuration, is created on the target host. The Cloud Server's memory is then copied to the new machine.
3. **Suspension and transfer:** The Cloud Server is briefly suspended on the source host. Any changes made to the memory after the initial copying are copied to the new machine. Storage and network traffic are disconnected from the source host.
4. **Resumption:** Storage and network connections are re-established on the target host, and the Cloud Server resumes operation seamlessly.

Unlike a traditional migration of a virtual machine, live migrations are significantly faster because all storage is handled by a [dedicated storage system](/docs/products/block-storage/storage-system.md). This eliminates the need to copy large amounts of data between hosts, a process that could result in minutes or even hours of downtime.

## Impact on server operations

Live migration has minimal impact on server operation, typically unnoticed by users. You might observe a brief pause of a few seconds (typically 2-30 seconds, depending on the server size) while memory is synchronised and connections are transferred to the new host. There is no performance degradation of storage or network traffic during this process.

By utilising live migration, UpCloud minimises maintenance windows and avoids the need for forced Cloud Server reboots, all while ensuring our infrastructure remains updated and secure.
