# Block Storage

Block Storage is used by Cloud Servers to store their operating system, application data and other files.

Block Storage devices are created automatically for new servers, and more storage can be added by expanding the storage device or attaching new storage devices.
Servers can be scheduled to take [backups](/docs/products/block-storage/backups.md) of attached block storage devices automatically. Additionally, manual backups can be taken at any time. [Storage import](/docs/products/block-storage/storage-import.md) can be used to bring installation media or to migrate existing servers to UpCloud.

All block storage is served from [a storage area network](/docs/products/block-storage/storage-system.md), enabling it to be attached to any Cloud Server at the same location. Block Storage is available [in three tiers](/docs/products/block-storage/tiers.md).

## Sizes and limitations

Each storage device can be scaled from 10 GB up to a maximum of 4 TB per volume in 1 GB increments. Cloud servers can attach up to 16 concurrent storage devices per server to a total of 64 TB of storage.

- Minimum size per device: 1 GB
- Maximum size per device: 4 TB
- Maximum number of devices per server: 16
- Maximum total storage per server: 64 TB

## Guides

- [How to increase storage size](/docs/guides/increasing-storage-size.md)
- [How to add and remove storage devices](/docs/guides/adding-removing-storage-devices.md)
- [How to manage storage devices](/docs/guides/managing-storage-devices.md)
- [How to use custom server images](/docs/guides/custom-server-images.md)
- [How to import your own server image](/docs/guides/importing-server-image.md)
- [How to use your own installation media](/docs/guides/using-own-install-media.md)

[All Block Storage guides](/docs/guides/block-storage.md)
