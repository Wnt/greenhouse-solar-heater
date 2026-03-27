# Resizing Cloud Servers

Cloud Servers can be reconfigured after deployment at the UpCloud Control Panel under the Plan and Storage tabs. This allows users to increase or decrease their Cloud Server resources to make changes as required without the need for redeployment.

## Summary of server resize operations

| Operation | Server is started | Server is stopped |
| --- | --- | --- |
| Add CPU & memory | Supported \* | Supported |
| Remove CPU & memory | Not supported | Supported |
| Add storage devices | Supported | Supported |
| Remove storage devices | Supported \*\* | Supported |
| Resize storage devices | Supported \*\*\* | Supported |

\* Depending on available resources on the host
\*\* Make sure the device is fully unmounted first
\*\*\* Partition and filesystem must be resized on the Cloud Server

## Scaling up

Increasing Cloud Server resources, or scaling up, allows users to allocate more CPU cores, system memory, and storage when more capacity is needed.

Users can upgrade their Cloud Servers easily by selecting a larger plan in the control panel in the server settings under the Plan tab.

When switching server plans, the storage device can be optionally grown to the full size allowed by the new plan. If the server is planned to be scaled back down later, it is recommended to leave the storage at the smaller size since storage devices cannot be shrunk.

New storage devices can be added, and existing storage can be resized to a larger size.

## Hot resizing CPU & memory

Hot resizing allows users to increase their Cloud Server resources without needing to shut down the server. The feature is automatically enabled on Cloud Servers created after April 27th, 2022. Servers created before this date require a single full stop and start for hot resizing to become available.

The maximum amount of increased resources depends on the available resources on the Cloud Server's current host machine. If the current host doesn't have enough resources available, a stop and start is required for the resize.

Hot resizing system memory is done using virtual memory slots. Each Cloud Server has a fixed number of memory slots. Every time memory is added using hot resize, vacant slots are used to add the additional memory. If all slots are already in use, system memory cannot be increased using hot resize until the server is shut down and started. After a full restart, allocated system memory is consolidated into larger chunks and the slots are freed for further hot resizing.

## Hot resizing storage

Storage devices can be grown to a larger size even when the server is powered on. The operation will grow the backing storage volume, but the partition table and filesystem must be grown from within the Cloud Server.

### Resizing the filesystem after storage expansion

After expanding a storage device from the Control Panel, you need to extend the partition and filesystem within your operating system:

**For Linux servers:**

```
# View current disk layout
lsblk

# Resize the partition (example for /dev/vda1)
sudo growpart /dev/vda 1

# Resize the filesystem (ext4 filesystems: Ubuntu, Debian)
sudo resize2fs /dev/vda1

# Resize the filesystem (XFS filesystems: CentOS, Rocky, Alma)
sudo xfs_growfs /

# Verify the new size
df -h
```

**For Windows servers:**

1. Open Disk Management (diskmgmt.msc)
2. Right-click on the volume you want to extend
3. Select "Extend Volume"
4. Follow the wizard to use the additional space

Note

Always back up important data before resizing partitions and filesystems.

## Scaling down

Cloud Servers can be scaled down by selecting a plan with fewer resources. The server must be stopped to scale down.

Scaling down does not reduce the storage device size automatically. This needs to be done manually by the user by creating a new smaller storage device and copying data from the old storage.

### Reducing storage size

Since storage cannot be automatically shrunk, follow these steps if you need to reduce storage size:

1. Create a new storage device with the desired smaller size
2. Attach the new storage to your Cloud Server
3. Copy or move your data from the old storage to the new storage
4. Update your system configuration to use the new storage device
5. Detach and delete the old storage device

## Swapping between plan types

In addition to being able to resize Cloud Servers, it's possible to freely change between different server plan types (i.e., from General Purpose to Cloud Native or vice-versa) at the UpCloud control panel under the resize menu. Selecting a plan of a different type will change how the Cloud Server is billed accordingly.
