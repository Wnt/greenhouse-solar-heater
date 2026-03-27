# Safely decreasing storage size on Ubuntu and Debian Cloud Servers

Decreasing the storage size involves creating a new storage device with the desired size, transferring all data from the old drive to the new one, and then deleting the old storage drive. This way all data is kept secure during the operation and everything gets safely copied as long as it can fit in the target space.

We highly recommend [taking a backup](/docs/guides/taking-backups.md) of your server before resizing storage.

Start by creating a new storage device with the preferred size in the [UpCloud Control Panel](https://hub.upcloud.com/). Note that your server must be powered down before the required options become available.

Go to the Storage section in your server settings and click the *Add new device* button underneath the list of your existing storage devices.

In the following dialogue window, select *New storage device*, give the storage the required size and name, then click the *Add a storage device* button to confirm.

![alt text](img/image.png)

You should now see a second storage device below the original.

![alt text](img/image-1.png)

After the attaching process is complete, start your server up again.

Once your server is up and running, you can continue the resizing process at the OS level.

**Decreasing storage size on Linux**

Check the name of the newly added storage disk using the following command.

```
lsblk
```

```
NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS
vda    253:0    0  50G  0 disk
├─vda1 253:1    0   1M  0 part
└─vda2 253:2    0  50G  0 part /
vdb    253:16   0  25G  0 disk
```

Here, the `vda` disk with the two partitions (`vda1` and `vda2`) is your primary storage device. The disk you are looking for is usually the last on the list and will not have partitions on it.
In the example above, that disk is `vdb`. Create a new partition on the new disk using fdisk.

```
sudo fdisk /dev/vdb
```

The utility will open its own command prompt showing *Command (m for help):* instead of the usual *user@host:/$.* The following one letter commands will be entered there.

First, start the new partition wizard with the command ***n***. Use default values by just pressing enter on each of the options, or type in the required parameter if no default value is given.

```
> n
# Primary p, partition 1, start sector 2048, end sector at disk end.
```

With the partition created, make it bootable with the command ***a***.

```
> a
# Partition 1 if asked.
```

Afterwards, you can check that the partition was configured properly and is marked bootable with ***p***
, it should show something along the lines of the example underneath.

```
> p
Device     Boot Start      End  Sectors  Size Id Type
/dev/vdb1  *     2048 52428799 52426752   25G 83 Linux
```

If everything is in order, write partition changes to the disk using the command ***w***. In case there was a mistake in the setup, delete the faulty partition by entering the command ***d*** and then create a new one again with command ***n***.

```
> w
```

Once fdisk has finished writing the partition table to the disk, it will exit and return you to the usual command prompt. Check that the new partition shows up using the *lsblk* command.

```
lsblk
```

```
NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS
vda    253:0    0  50G  0 disk
├─vda1 253:1    0   1M  0 part
└─vda2 253:2    0  50G  0 part /
vdb    253:16   0  25G  0 disk
└─vdb1 253:17   0  25G  0 part
```

You should see both disks and their partitions with their correct sizes. The disks will be named like vda or vdb and their partitions with the added partition identifier number e.g. vda1 or vdb1. Notice that some of the commands below require you to enter the disk name while others use the partitions.

Set up the partition with a file system type appropriate for your server. Ubuntu and other Debian variants should use EXT4, while CentOS 7 machines might prefer using XFS instead.

```
# Creating an EXT4 file system on Debian, Ubuntu.

# 1 - Check your current disk's UUID.
sudo cat /etc/fstab

# 2 - Replace the <UUID> in the next command with it.
sudo mkfs.ext4 -U <UUID> /dev/vdb1
```

Afterwards, mount the new storage disk on your system so that you can copy the files over.

```
sudo mount /dev/vdb1 /mnt
```

We recommend using rsync to copy such large amounts of files that your operating system might contain. It provides convenient options for copying all the files from your current disk to the new one, while also keeping track of the copy process allowing you to continue from where you left off if you have to cancel the copying for some reason.

Install rsync if you do not already have it.

```
sudo apt-get install rsync
```

The rsync command here uses the options for verbose output so that you can easily see what is getting copied. However, having a large amount of output on the display might slow down the process with a larger number of small files.

You can disable the printout by omitting the parameter –*v* from the command, or having the output redirected to a file by adding `> ~/filename.txt` to the end of the command.

```
sudo rsync -avxHAX / /mnt
```

Once the copy process has finished, check the disk space usage to see that everything was copied. The used space will not be exactly the same, but the difference should be minimal.

```
df
```

Lastly, install a boot manager on the new disk so that you can boot again with a new main storage device. You need to install the correct version of GRUB depending on your system.

Commonly Ubuntu and Debian use the first version.

```
sudo grub-install /dev/vdb --root-directory=/mnt --recheck
```

You should see a confirmation like in the example output below.

```
Installing for i386-pc platform.
Installation finished. No error reported.
```

After that, shut down your server either with the Shutdown request at your [UpCloud Control Panel](https://hub.upcloud.com/) or by using the following command in your server terminal

```
sudo shutdown -h now
```

With your server powered down, go to the Resize tab again and click the eject icon on the former main disk, then start up your server. Confirm that all of your data was copied successfully and is available on the new disk.

In case the server cannot find the boot section and fails to start. Shut down the server and attach the original disk again to boot from. Then reinstall the GRUB and try booting from the new disk again by detaching the old disk.

Afterwards, you can delete the old disk at your UpCloud Control Panel in the [Storage device](https://hub.upcloud.com/storage) section.
