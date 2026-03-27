# How to migrate onto MaxIOPS

If you are using our faster-than-regular HDD storage devices but crave more I/O performance, there is no need to manually migrate your data. Fortunately, it is quite simple to move onto MaxIOPS using our cloning features.

The process is a bit more straightforward if you use our API, but can also be done at your [UpCloud Control Panel](https://hub.upcloud.com/).

## Cloning storage at the control panel

To migrate onto MaxIOPS, you can [clone a backup of your HDD device](/docs/guides/server-cloning.md) and then choose to attach the disk to an existing or new server.

Go to your server settings at the [UpCloud Control Panel](https://hub.upcloud.com/) and take a backup of the HDD storage device.

![Backup HDD only](img/image.png)

Then head over to your [Storage and backups list](https://hub.upcloud.com/storage/backups). Click the copy icon to clone the backup onto a new storage device.

![Clone the HDD backup](img/image-1.png)

When cloning the backup, select the storage type as MaxIOPS and click Accept.

![Clone HDD backup to MaxIOPS](img/image-2.png)

Since the cloning process creates a new storage device you have two options depending on the original use of the HDD storage.

You can mount the new MaxIOPS clone of the original HDD onto an existing server. For more information about attaching and detaching devices, see our guide for [managing storage](/docs/guides/managing-storage-devices.md).

Alternatively, if the HDD was used as the operating system device, you can [create a custom image of the clone](/docs/guides/custom-server-images.md) and deploy it onto a new server.

After making sure that everything works with the new MaxIOPS storage, you can delete the old HDD device and the temporary backup.

## Cloning storage using the API

The [Cloning Storage section of our API documentation](https://developers.upcloud.com/1.3/9-storages/#clone-storage) describes cloning just the storage device. In a nutshell, you can clone storage with the following API request. Replace the {storage\_uuid} with the UUID of the HDD device you wish to clone.

```
POST /1.2/storage/{storage_uuid}/clone
{
    "storage" : {
        "zone" : "fi-hel1",
        "tier" : "maxiops",
        "title" : "Clone of operating system disk"
    }
}
```

The response will give you details such as the UUID of the new storage disk.

After the cloning process, you can attach the new disk to your server, detach the old disk and verify that everything is working. You may delete the old disk at your discretion.
