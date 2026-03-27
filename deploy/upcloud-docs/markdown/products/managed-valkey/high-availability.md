# Managed Valkey High availability

In clustered database deployments, nodes are created on physically separated backend hosts to ensure redundancy in case of hardware failure.

In the event of a Valkey™\* node failure, the primary node maintains normal operations, ensuring uninterrupted service for client applications. Upon readiness, the replacement standby node synchronises with the primary node and begins real-time replication to stabilise the system.

If the failed node is a Valkey primary node, a failover decision is made based on information from the monitoring infrastructure and the standby node. The standby node is elevated to the role of the new primary node and immediately assumes serving clients. Simultaneously, an automatic process schedules a replacement node to serve as the new standby node.

In the rare scenario where both the primary and standby nodes fail simultaneously, automatic creation of new nodes occurs to assume their roles. However, this process entails some data loss because the primary node is restored from the most recent available backup. Consequently, any writes made to the database since the last backup will be forfeited.

The database instance is reachable via the hostname which takes the form of `instancename.db.upclouddatabases.com`. In normal operation, this hostname is pointed towards the primary node. In the event of a node failure, a standby node is elevated to primary and the hostname is instantly pointed towards the new primary node.

### Primary and Standby Nodes

The multi-node plans include primary and standby nodes, providing redundancy and enhanced reliability. Standby nodes serve several key purposes:

- **Data Redundancy:** They maintain an additional physical copy of the data, guarding against hardware, software, or network failures.
- **Disaster Recovery:** Standby nodes help minimize data loss in disaster scenarios, reducing the time needed to restore operations.
- **Quick Recovery:** With synchronized data and pre-installed standby nodes, failover processes are quicker and controlled, ensuring faster restoration of services.
- **Read-Only Queries:** Standby nodes can handle read-only queries, alleviating the load on primary servers.

### Standby Nodes as Read-Only

Standby nodes can serve as additional nodes dedicated to handling read-only queries, alleviating the load on the primary nodes and enhancing performance. These standby replicas can be accessed via a separate DNS entry, which will balance queries across all available standby nodes. By offloading read operations to these replicas, the primary nodes can focus on handling write operations and maintaining data consistency.

### Handling Failures

The system handles minor failures, such as service process crashes or temporary network disruptions, seamlessly across all plans. Automatic recovery mechanisms ensure crashed processes or restore network access, ensuring minimal impact on service availability.

For severe failures, like node loss due to hardware or severe software issues, the monitoring infrastructure detects issues promptly. Upon detection, it automatically schedules the creation of replacement nodes to restore system integrity and functionality.

\* Valkey and the Valkey logo are trademarks of LF Projects, LLC. Any rights therein are reserved to LF Projects, LLC. Any use by UpCloud is for referential purposes only and does not indicate any sponsorship, endorsement or affiliation between Valkey and UpCloud.
