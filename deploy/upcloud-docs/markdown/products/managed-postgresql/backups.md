# Managed PostgreSQL Backups

Each Managed Database plan includes automated backups. The retention period is set to either 3, 15 or 31 days for 1, 2, and 3 node clusters respectively. The 1-node plans allow the user to go back to any given point in time (PITR) within the last 3 days. 2-node plans offer 15 days of backups and 3-node plans include 31 days.

The backup time configuration can be adjusted in the service settings, which will shift the backup schedule accordingly. If a recent backup was taken, it might require an additional backup cycle before the new schedule takes effect.

The databases are backed up with a [full backup](/docs/products/managed-postgresql/backups#full-backups.md) made daily, and the write-ahead log (WAL) is copied continuously at 5-minute intervals, or for every new file generated. All backups are encrypted using `pghoard`.

All backups are encrypted and stored off-site independently of the user’s Managed Database without using the cluster’s storage capacity.

### Full Backups

Full backups are version-specific binary backups that capture the entire PostgreSQL® instance, including uncommitted transactions, deleted and updated rows that haven't been cleaned up, and all data from indexes. They can be restored with the same PostgreSQL version as the backup was created from, enabling consistent recovery to a specific point in time (PITR) when combined with WAL files. Restoring from a full backup is almost instantaneous, requiring only the restore of the backup and replaying of delta WAL files.

### Delta Base Backups

PostgeSQL databases use delta base backups efficiently to store only the changed data since the last backup, omitting unchanged files. This approach is especially useful for databases with large static data portions. It enhances backup performance and speed, especially for large databases with significant data volumes. With delta base backups, more frequent backups are possible, potentially speeding up service restoration and node replacement due to fewer WAL files to restore.

PostgreSQL is a registered trademark of the PostgreSQL Community Association of Canada, and used with their permission.
