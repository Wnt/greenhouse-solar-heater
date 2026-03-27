# Attaching storage to Cloud Servers

Block storage devices are the fundamental building blocks for storing data on your UpCloud Cloud Servers. They act as virtual hard drives that can be attached to your servers to hold your operating system, applications, and any other data you need to store.

A minimum of one block storage device holding the operating system is required for a Cloud Server to start. Each server supports a maximum of 16 storage devices. All storage devices, including operating system devices, can be freely moved between servers.

UpCloud offers different types of block storage with varying performance characteristics and pricing. You can choose the storage tier and size that best suits your needs and budget, giving you full control over your server's storage environment.

## Creating new storage devices

Storage space can be added to a Cloud Server by creating and attaching new, empty storage devices.

![New storage device creation modal](new-storage-device.png)

Storages are created from the Storage tab in the server details view.

The storage device can be from any of the three available [Block Storage tiers](/docs/products/block-storage/tiers.md): MaxIOPS®, Standard, or Archive. Supported sizes range from 1 GB to 4 TB per storage device.

|  | MaxIOPS | Standard | Archive |
| --- | --- | --- | --- |
| Use case | High performance | General purpose | High capacity |
| Capacity | 1 GB – 4 TB | 1 GB - 4 TB | 1 GB – 4 TB |
| Performance (4k block size) | Read: 100 000 IOPS Write: 30 000 IOPS | Read: 10 000 IOPS Write: 10 000 IOPS | Read: 600 IOPS Write: 600 IOPS |
| Availability | All locations | All locations | All locations |

You can optionally create storage devices with [encryption at rest](/docs/products/block-storage/encryption-at-rest.md) enabled, which transparently encrypts all data written to the device.

## Attaching existing storage devices

Any unattached storage device can be attached to any server within the same UpCloud location.

![Attach existing storage modal](attach-existing-storage.png)

Any detached storage can be attached to any server within the same location.

## Detaching storage devices

A storage device can be detached from a server to be saved as a copy of the stored data, or to be moved to another server.

## Moving storage devices between servers

Block storage devices can be moved between servers simply by detaching and attaching on a new server. Operating system devices are not different from any other storage device and they can also be moved between servers. Storage devices are bound to the location they are created in, and can be attached to any server within that same location. Storage devices can be cloned over the network to be used at other locations.

## Boot order

The boot order defines the order of block storage devices from which the server attempts to boot the operating system. The server should normally be configured to boot from `storage`, but the boot order can be changed, for instance, to boot the server from a live CD-ROM media for troubleshooting. When `storage` is selected as the boot option, booting is attempted from any attached storage device in order of appearance.

![Boot order selection](boot-order.png)

Boot order is defined by in the Optionals section of a server's configuration.

## Storage controllers

UpCloud supports four different storage controllers. VirtIO should always be used when the server is operating normally.

- **VirtIO**: Para-virtualised SCSI controller for maximum performance. Requires support from the operating system. Public templates have the required drivers built-in.
- **SCSI** and **IDE**: Legacy SCSI and IDE support to allow operating systems without VirtIO support to be able to boot and use storages devices.
- **CDROM**: The storage is exposed as a read-only media to the server.

MaxIOPS is a registered trademark of UpCloud Ltd.
