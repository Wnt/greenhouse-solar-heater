# Managed PostgreSQL FAQ

## Reliability

**How is high availability ensured on Managed Databases?**

UpCloud Managed Databases work using the master/replica model to provide dependable high-availability. This means all writes are done on the master node, but you are free to query the read-only replicas for added performance. Single master node ensures consistent transaction handling which can otherwise become an issue with multi-master HA solutions.

DBs like PostgreSQL® and MySQL®, where there's a single primary node and several replica nodes, we give two different hostnames: one for the primary (which is write-capable), and one which contains all of the replicas (which are read-only). A DB client will randomly choose one of the IP addresses in the DNS A record for the replica, which will naturally spread the load across those nodes.

**Do you promote a replica to primary automatically in case of a failure with the master node?**

Yes, if the management system detects a failure with the master node, it will seamlessly promote one of the replica nodes to take over the write tasks. Note that the automated fail-over is only possible with clusters of 2 or more nodes.

**Can I take backups of the databases?**

All databases are [backed up automatically](/docs/products/managed-postgresql/backups.md) with full backups taken daily. These allow you to go back to any minute from the last 24 hours. 2-node plans have additional 7 days of backups and 3-node plans include 14 days.

**Are the backups encrypted at rest?**

Yes, all backups are [encrypted and stored off-site](/docs/products/managed-postgresql/backups.md) independently from the Managed Database without affecting the cluster’s storage capacity.

## Operations

**Is it possible to connect to the database using private networking?**

[Private connection](/docs/products/managed-postgresql/connecting.md) is enabled by default via the UpCloud Utility network. Note that the private network access is only available to Cloud Servers within the same UpCloud account and data centre.

**Can the connections be restricted to specific IP addresses?**

You can set [connection permissions](https://hub.upcloud.com/database) either by granting access to specific Cloud Servers on your UpCloud account or manually inputting the IP addresses of the hosts you want to be able to connect.

**What is the maintenance window and what does it mean to me?**

The [maintenance window](/docs/products/managed-postgresql/maintenance.md) is used to handle system updates and other management tasks during off-hours. You can set the maintenance window at your [UpCloud Control Panel](https://hub.upcloud.com/database) according to the time and day of the week you prefer.

**How are Managed Databases billed?**

Database clusters are billed hourly according to the selected configuration plan starting from the cluster creation until the instances are deleted. Billing continues as long as the instance exists, even if it is stopped. Monthly prices are estimates based on a 30 day month.

PostgreSQL is a registered trademark of the PostgreSQL Community Association of Canada, and used with their permission.
