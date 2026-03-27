# Block Storage FAQ

## Storage features

**What is MaxIOPS and how does it differ from SSD?**

[MaxIOPS](https://upcloud.com/products/block-storage/#maxiops)® is our in-house developed storage technology, which gives you industry-leading performance and reliability. It’s leaps and bounds faster than the typical SSD storages found on competing providers. Check out how much faster our storage is on our [comparison pages](https://upcloud.com/competitors-and-alternatives/).

**Do you have other storage options?**

We offer [MaxIOPS, Standard and Archive block storage](/docs/products/block-storage/tiers.md) and [Object Storage](/docs/products/managed-object-storage.md).

**Do I need to pay extra for persistent storage?**

Not at all. Every storage device, whether MaxIOPS, Standard or Archive, is fully persistent.

**Are your storage devices encrypted?**

[Encryption at Rest](/docs/products/block-storage/encryption-at-rest.md) is available as an optional feature for all block storage devices.

MaxIOPS is a registered trademark of UpCloud Ltd.

## Storage management

**How much storage can I have per server?**

Each Cloud Server can have up to 16 storage devices 4 TB each to the maximum of 64 TB of storage capacity. You can always add more storage capacity after deployment. Find out more at our guide to [adding and removing storage devices](/docs/guides/adding-removing-storage-devices.md).

**How do I change storage size?**

You can increase storage size at your control panel under the Resizing tab in the server settings. Afterwards, you also need to increase the storage in the operating system of your Cloud Server. Find out how by following this [guide](/docs/guides/increasing-storage-size.md).

**I've increased my storage size, but it didn't change on my server.**

You need to tell your server operating system to use the new storage space. Learn more in this [guide](/docs/guides/increasing-storage-size.md).

**Do you offer server backups?**

Of course! You can take manual snapshot backups of any storage device on your server or [schedule automatic backups](/docs/products/block-storage/backups.md). The backups are a quick way to restore an earlier state of your server or a simple way to archive data. Read more about backups in our [guide](/docs/guides/taking-backups.md).
