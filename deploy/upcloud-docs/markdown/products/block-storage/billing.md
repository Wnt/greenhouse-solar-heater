# Block Storage billing

## Block storage

Cloud Server plans include storage up to the allocated quota. Developer Plans use Standard storage and all other plans use MaxIOPS® storage.

If the server has multiple storage devices, the largest storage that fits within the plan quota is counted as part of the plan. Any additional storage devices are billed per GB per hour, as shown in the table below. Please refer to our [pricing page](https://upcloud.com/pricing/#block-storage) for the exact costs in your currency.

| Storage Tier | Predefined Plans | Additional Storage |
| --- | --- | --- |
| MaxIOPS | No cost within quota | Billed per GB per hour |
| Standard | No cost within quota | Billed per GB per hour |
| Archive | Billed per GB per hour | Billed per GB per hour |

**Note:** Archive tier replaced HDD tier in August 2024.

## Backups

Simple Backups are billed at a fixed monthly rate according to the selected plan at either +20%, +40% or +60% of the monthly Cloud Server plan it is applied. For example, the Week plan would cost [ plan price + (20% of plan price) ] per month. With Simple Backup, the price is always the same, irrespective of how many backups have already been taken.

Backups of storage devices that are not part of a plan are billed as an additional storage at per GB per hour. This is analogous to how excess storage is billed for Cloud Servers.

Additional backups and backups of storage devices outside the General Purpose, High CPU and High Memory plans are billed at per GB per hour.

Flexible Backups are billed at per GB per hour. With Flexible Backups, the total monthly cost depends on the number of backups taken, their retention period and the size of the storage devices being backed up. This means that the monthly cost accumulates over time as the schedule creates new backups until the retention period is reached and the oldest backup is deleted.

On-demand backups are billed individually at per GB per hour.

Please refer to our [backup pricing](https://upcloud.com/pricing/#simple-backups) for costs in your currency.

## Encryption at Rest

[Encryption at Rest](/docs/products/block-storage/encryption-at-rest.md) is offered free of charge to all block storage devices.

MaxIOPS is a registered trademark of UpCloud Ltd.
