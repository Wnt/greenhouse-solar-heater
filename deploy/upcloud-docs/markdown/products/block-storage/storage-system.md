# Block Storage system

Cloud Servers are deployed on high-performance block storage, which provides tolerance against failures through the use of storage clusters. All block storage is served from a storage area network where data is stored in clusters of two separate storage backends to ensure high performance and uninterrupted availability. Additionally, data on the storage backends is stored on multiple physical drives in a RAID array to further improve redundancy.

Unlike traditional cloud providers, UpCloud does not store any block storage data locally on the hypervisor. Instead, all block storage is provided from the storage area network. Consequently, any storage device can be attached to any Cloud Server within the same location. This setup also ensures quick recovery times in case of hardware failures, as there is no need to move data between servers. It's important to note that a storage device can only be attached to a single server at a time.

Users are offered a choice between [MaxIOPS®, Standard and Archive storage tiers](/docs/products/block-storage/tiers.md), each with user-selectable capacity. All storage tiers share the same production model and practices described above.

MaxIOPS is a registered trademark of UpCloud Ltd.
