# Managed MySQL Backups

Each Managed Database plan includes automated backups and continuous recording of binary logs. The retention period is set to either 2, 8 or 15 days for 1, 2, and 3 node clusters respectively. The 1-node plans allow the user to go back to any given point in time (PITR) within the last 48 hours. 2-node plans offer 8 days of backups and 3-node plans include 15 days.

The backup time configuration can be adjusted in the service settings, which will shift the backup schedule accordingly. If a recent backup was taken, it might require an additional backup cycle before the new schedule takes effect.

For safe backups, MySQL `INSTANT ALTER TABLE` operations use either the `INPLACE` or `COPY` algorithm instead of `INSTANT`. Although specifying `ALGORITHM=INSTANT` won't cause a failure, it automatically defaults to `INPLACE` or `COPY`.

### Backups and Encryption:

For encryption during backups, `myhoard` open-source software is used, which internally employs `Percona XtraBackup` for full or incremental snapshots of MySQL®.

Starting with `Percona XtraBackup 8.0.23`, the `--lock-ddl` option is enabled by default. This prevents DDL changes during a backup, ensuring the backup service's consistency and reliability for restoration. If you attempt to execute commands like `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, or similar during a backup, you may encounter a "Waiting for backup lock" message. In such cases, wait for the backup to complete before proceeding with these operations.

All backups are encrypted and stored off-site independently of the user’s Managed Database without using the cluster’s storage capacity.

MySQL is a registered trademark of Oracle and/or its affiliates. Other names may be trademarks of their respective owners.
