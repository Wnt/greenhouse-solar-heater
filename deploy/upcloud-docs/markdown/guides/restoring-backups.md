# Restoring backups

UpCloud provides two ways to restore data from your storage backups. You can either revert the entire storage device to a previous backup snapshot, or you can clone the backup to new storage and restore individual files by mounting the cloned device onto a server.

## Restoring backup

This method will overwrite the existing storage device entirely with the selected backup. All data on the device will be returned to the point at which the backup was taken. This is very useful for reverting major changes to your current system.

Note that the cloud server must be shut down during the backup restore procedure.

Start by going to your server settings at your [UpCloud Control Panel](https://hub.upcloud.com/) and open the *Backups* tab. On the History list, you’ll see all of the backups of your server. For each backup, you can find the date and time of when the backup was taken and controls to restore or delete the backup.

Select the backup you wish to restore, click the Restore button, and then confirm you wish to continue by clicking the *Ok* button when asked.

![Restore backup](img/image.png)

The backup restoration will only take a moment depending on your storage size and type, MaxIOPS is considerably faster at all storage procedures than an HDD of the same size. You can follow the progress on the *Backups* tab.

![Restoring backup](img/image-3.png)

Once the restore has finished, you can start the server as normal.

Note that while the restoration to a runnable status is quick, other storage operations will continue in the background which will limit your ability to immediately make new backups. You can see the status of the background process on the [Storages page in your control panel](https://hub.upcloud.com/storage).

## Cloning backup

It is also possible to clone a backup onto a new standard storage device. You can then attach the clone to the original server, or to any other, as secondary storage. Attaching a backup clone to your existing server allows you to access individual files from the device without needing to revert the entire system.

To start, go to the Backups sections under the Storage page in your [UpCloud Control Panel](https://hub.upcloud.com/). Find the backup you wish to access on the list and click the Clone button.

Give the backup clone a name you’ll recognise later and click Accept to proceed.

![Clone backup](img/image-1.png)

![Clone backup](img/image-2.png)

The cloning will take a moment depending on the size of your backup and the storage device type you selected as the target. You can check the status in your [Storage devices section](https://hub.upcloud.com/storage). While cloning, the cloned storage device will show that the operation is in progress. Once the operation has finished you’ll see the same controls as for the other storage device listed on the same page.

## Attaching storage to an existing server

Once the cloning process is complete shut down the server, then go back to your server settings and open the *Storage* tab. Under the attached *Storage* resources you’ll find the option to manage the storage devices.

Note that the cloud server must be shut down before attaching new storage devices.

Click on the *Attach existing device* button, then find the disk clone you made earlier and select it from the Device list and finally click the *Add a storage device* button to confirm the action.

![Attach backup clone](img/image-4.png)

Afterwards, you’ll see the cloned device shows up as an attached resource, you can now start up the server again.

![Attached backup](img/image-5.png)

## Restoring files on Linux servers

Linux systems will require you to mount the new storage to access the files from the backup clone. Do this by first creating a mounting point to your file system with the following command.

```
sudo mkdir /media/backup
```

Check the device name and partitions you just attached to the server with the command below.

```
lsblk -io KNAME,TYPE,SIZE
```

The output will show a list of storage devices usually named *vda*, *vdb* or *vdc* and their partitions such as vda1 and vdb1.

If you are not sure which of the partitions is on the cloned backup, you can check your current system partitions with this command.

```
df -h
```

The command will list the partitions and their sizes currently configured on your server. Select a partition from the `lsblk` printout that is not yet in use, for example, if your system partition is called vda1, select vdb1 for mounting.

Then simply mount the new storage device partition to the directory you just created with the following command. Make sure to replace `{partition}` with your actual partition. Also take note of the space between the partition path and the mount path.

```
sudo mount /dev/{partition} /media/backup
```

After mounting the device you can restore any and all files you wish by simply copying them over.

## Restoring files on Windows servers

Windows servers might require you to take a couple of steps before you are able to access the backup files. Start by connecting to your server, for example, through Remote Desktop. Once logged on type in `diskmgmt.msc` to the Windows search and open it by pressing Enter.

In *Disk Managemen*t, you’ll see the previously existing disks and the newly added backup clone that will likely show as offline. Right-click the clone storage and select *Online*.

![Disk manager](img/image-6.png)

Depending on your Windows server version, you might get a pop-up asking to scan the new drive, you can skip this by clicking *Continue without scanning*.

With the disk online, you can now access it normally through the file browser to copy over any files you wish to restore.

## Removing cloned disk

Once you have restored the files you needed, it is as simple as shutting down the server again, detaching the backup clone and deleting it. Go back to your server settings again and open the Storage tab.

Under the attached *Storage* resources list you’ll find the option to detach or delete.

If you do not wish to delete the backup clone just yet, you can simply click the eject icon and leave the disk for later use. Otherwise, you can just click the bin icon and the disk will get detached and deleted.

![Delete clone](img/image-7.png)

Don’t forget to make regular backups of your server again after restoring files.

## Notes on the backup technology

The steps required to restore and access files in backups might seem complicated, but we aim to make the process as simple as possible. Our backup technology focuses on data integrity while being fast and easy to operate. However, it comes with a couple of main differences from some other backup models.

### It is not possible to restore individual files automatically

We handle storage devices and their backups as full media images. Access to individual files would require knowledge of used partitioning, file systems and possible storage encryption, which would reduce your data privacy. Due to this, it is not possible for us to neither restore backups for you nor provide a graphical user interface to access or browse the contents of the backups.

### Backups cannot be attached directly to a server

Backups are stored in separate storage systems which maximize storage security over IO and access properties. Due to these limitations, it is not possible to directly attach backup snapshots. Instead, new standard storage can be created by cloning the backup.
