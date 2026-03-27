# Backups

Backups on UpCloud are instant one-to-one snapshots of an entire storage device created without interruption or slowing down the storage operations on the Cloud Server.

UpCloud users have two options for scheduling backups of their Cloud Servers – easy-to-use [Simple Backups](/docs/products/block-storage/backups#simple-backups.md), and custom-scheduled [Flexible Backups](/docs/products/block-storage/backups#flexible-backups.md). In addition, users have the option to take manual instant [on-demand backups](/docs/products/block-storage/backups#on-demand-backups.md).

Backup plans are configured on a per-server basis at the UpCloud Control Panel or via our API. On-demand backups are taken manually off a specific storage device.

All backups are stored in the same data centre as the origin Cloud Server to enable fast restoration.

## Simple Backups

Simple Backups offer packaged backup plans with a number of concurrent snapshots at a rotating schedule. The plans for Simple Backup include backups of the main system storage for a predefined plan Cloud Server with a one day, week, month, or year retention period.

When a Simple Backup plan is enabled, the number of concurrent backups of a cloud server increases as new backups are taken until the maximum number of backups afforded by the plan is reached and the oldest backup is deleted.

Simple Backup is charged on top of the Cloud Server's plan price, as a percentage of the plan price. Users can select from the following options:

| Plan name | API/CLI flag\* | Price | Daily backups | Weekly backups | Monthly backups |
| --- | --- | --- | --- | --- | --- |
| Day Plan | `daily` | Free / +10%\*\* | 1 day |  |  |
| Week Plan | `dailies` | +20% | 7 days |  |  |
| Month Plan | `weeklies` | +40% | 7 days | 4 weeks |  |
| Year Plan | `monthlies` | +60% | 7 days | 4 weeks | 12 months |

\* The API/CLI flag column shows the value to use with the API or CLI.

\*\* The Day Plan is included for General Purpose, High CPU, and High Memory plans. For Developer plans, the Day Plan has an additional cost of +10%.

Cloud Native and GPU Server plans as well as any additional storage devices attached to Cloud Servers of all plans are billed per GB according to the selected retention period. [See the detailed pricing table for exact costs.](https://upcloud.com/pricing/#simple-backups)

Additionally, users can choose the time of the day backups are taken.

Note that if the Simple Backups plan is disabled or the Cloud Server is deleted, all existing backups are converted to on-demand backups and kept until deleted by the user.

## Flexible Backups

Flexible Backups allow users to configure their own backup schedules and retention periods as required. Users have the option to set snapshot schedules daily or weekly on a specific day of the week.

Each scheduled backup is kept for a set duration according to the selected retention period starting from 1 day and up to 3 years.

## On-demand backups

On-demand backups offer instant snapshots of the selected storage devices and can be taken manually at any time. On-demand backups offer the ability to jump back to revert the storage device to a specific moment in time, and are recommended to be taken for instance before making upgrades or other large changes to the server.

On-demand backups are never automatically deleted and will be kept until manually deleted.

## Restoring to the origin storage

Backups are full snapshots of a storage device that can be used to revert any and all changes on the origin storage. Any backup can be restored directly onto its origin storage devices which reverts the storage in its entirety to an earlier saved state.

The backup restoration process can take some time depending on the backup size and how recently the backup was taken. The most recent backups are kept on an active storage backend allowing quick restoration while older snapshots are archived on dedicated backup servers.

The Cloud Server must be shut down during the backup restoration process.

## Cloning to a new storage

Alternatively to restoring to the origin storage, backups can be cloned to a new storage device, which can then be mounted onto any Cloud Server allowing system-level access to the backup files. The new storage can also be used as a primary storage device to run an earlier state of the Cloud Server independently of the origin server.

Cloning a backup also allows users to transfer their backups off-site by selecting a different data centre where the backup is stored. Cloning to a different location will take time depending on the size of the backup. However, the process is performed independently of the Cloud Server the backup was taken from and does not require downtime of the server.
