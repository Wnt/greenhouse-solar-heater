# Managed OpenSearch High availability

In clustered database deployments, nodes are created on physically separated backend hosts to ensure redundancy in case of hardware failure.

To ensure high availability in multi-node plans, the OpenSearch setup configures indices to include at least one replica. These replicas are distributed across physically separated backend hosts, ensuring that primary and replica shards remain operational even if one host experiences downtime. The replication factor, controlled by the setting "number\_of\_replicas," determines the resilience of your data to failures.

The database instance is reachable via the hostname which takes the form of `instancename.db.upclouddatabases.com`. In normal operation, all nodes with synchronised shards respond to client requests. In the event of a node failure, the remaining operational nodes continue to handle client requests without interruption. Concurrently, for every primary shard on the lost node, the cluster promotes one in-sync replica shard and write requests are directed to these newly promoted shards.

### Failure Handling

Minor failures, such as service process crashes or temporary loss of network access, are automatically managed by the platform in all plans without requiring significant changes to the service deployment. Normal operation is restored automatically once the crashed process is restarted or when network access is re-established.

In the event of severe failures, such as the loss of a cluster node, more extensive recovery measures are initiated. The platform continuously monitors the health of every node in a cluster. If a node reports failures through its self-diagnostics or fails to respond to health checks, the platform initiates the replacement process. During node replacement, client requests are redirected to other nodes with replica shards. Once the new node joins the cluster, it restores data from existing nodes or from a backup if older nodes are unreachable, and resumes servicing requests upon completion of data restoration.
