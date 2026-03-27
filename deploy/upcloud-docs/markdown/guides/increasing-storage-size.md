# Increasing storage size

Scalability is one of the key benefits of cloud services allowing you to grow your usage along with your company. Going up in General Purpose plans affords you not only more CPU cores and memory but also storage.

However, increasing storage size also requires increasing the partition on the operating system level. Luckily, increasing storage size is quick and easy thanks to automated filesystem resizing!

In this guide, we’ll show you how to easily increase the storage size of your Cloud Server.

However, if you just need more storage space for data files, we suggest [adding new storage devices](/docs/guides/adding-removing-storage-devices.md) as once increased, the storage size cannot be reduced.

## Increasing storage device size

If you’ve scaled up your Cloud Server by changing up to a higher tier General Purpose plan, you might want to also take advantage of the included additional storage space.

Increasing storage size is a two-phase operation:

1 - First, you will need to reserve the **additional storage space** by expanding your current storage device at your UpCloud Control Panel.

2 - Then, **resize the filesystem** to allow your Cloud Server to use the added storage space.

Note that decreasing storage size is not quite as straightforward. If you expect to need to scale down your Cloud Server in the future, you might not want to increase your storage size until necessary.

Start by increasing the storage size at the [UpCloud Control Panel](https://hub.upcloud.com/). You will need to **shut down your Cloud Server** before you can change the storage configuration.

When your server is powered down, open your server settings and go to the Storage tab.

At the Storage resources list, **increase the storage device** size by using the slider or by entering the desired value in the text field on the right.

![Resizing storage size](img/image.png)

After you’ve selected the new desired storage size, click the Save button and then choose whether to **automatically resize the filesystem** or to do it manually afterwards.

![Automatically resize filesystem](img/image-1.png)

When saved to resize the filesystem and partition, the storage resizing is then performed automatically. Just sit back and wait for the process to complete before starting up your Cloud Server again.

![Resizing storage in progress](img/image-2.png)

Once the storage size has been successfully increased, the new capacity will show up in the device information. The capacity indicates the storage space allocated to the device.

Start up your Cloud Server again and confirm your storage device was increased successfully. When you are certain everything is in order, you can delete the automated backup made before applying changes to the storage devices.

## Manually extending a partition on Linux

If you chose to resize storage without applying changes to the filesystem and partition automatically, you will then need to make the changes manually. Before doing so, we highly recommend [taking a backup of your server](/docs/guides/taking-backups.md) before resizing storage.

When your Cloud Server is up and running again, log in using SSH.

Once in, check that your storage device has increased in size using the command below. Also, make note of your storage device and partition names.

```
lsblk
```

```
NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINT
vda    252:0    0   50G  0 disk
├─vda1 252:1    0 1007K  0 part
└─vda2 252:2    0   25G  0 part /
```

Commonly you would be increasing the primary storage, which is usually called *vda*. Any secondary storage devices would have a different dev name such as *vdb*, or *vdc*. You will notice that only the storage device size is showing the whole capacity you set at your UpCloud Control Panel, like 50 GB in the example output above. Follow through with the rest of this section to get the partition extended to use the whole storage space.

Start by running the following command to open the partitioning tool.

```
sudo parted
```

```
GNU Parted 3.3
Using /dev/vda
Welcome to GNU Parted! Type 'help' to view a list of commands.
```

Next, check the current partition details by using the `print` command as shown below.

```
(parted) print
```

Depending on your operating system, Parted may notice the new unused space available on the storage device. Enter "fix" as in the example below to continue.

```
Warning: Not all of the space available to /dev/vda appears to be used, you can fix the GPT to use all of the space (an extra 10485760
blocks) or continue with the current setting?
Fix/Ignore? fix
```

Once the partition manager has done its thing, or if Parted didn’t prompt you about the unused space, you’ll get a printout similar to the output underneath. Make note of the size of the storage device you extended, the last partition number and the filesystem type.

```
Model: Virtio Block Device (virtblk)
Disk /dev/vda: 53.7GB
Sector size (logical/physical): 512B/512B
Partition Table: gpt
Disk Flags:

Number  Start   End     Size    File system  Name                 Flags
 1      17.4kB  1049kB  1031kB               BIOS boot partition  bios_grub
 2      1049kB  26.8GB  26.8GB  ext4         Linux filesystem
```

You can now extend the filesystem partition with the `resizepart` command.

```
(parted) resizepart
```

Then make the following selections according to your storage size and partition number.

```
Partition number? 2
Warning: Partition /dev/vda2 is being used. Are you sure you want to continue?
Yes/No? yes
End? [26.8GB]? 53.7GB
```

If you do not get any output or error, you were successful in extending the partition. Verify this by using the `print` command again.

```
(parted) print
```

```
Model: Virtio Block Device (virtblk)
Disk /dev/vda: 53.7GB
Sector size (logical/physical): 512B/512B
Partition Table: gpt
Disk Flags:

Number  Start   End     Size    File system  Name                 Flags
 1      17.4kB  1049kB  1031kB               BIOS boot partition  bios_grub
 2      1049kB  53.7GB  53.7GB  ext4         Linux filesystem
```

With the partition resized, you can quit the parted application.

```
(parted) quit
```

Now that you have extended the partition to use the new storage space you are almost done. However, the filesystem still doesn’t know about it. You can check this by running the following command.

```
df -h
```

```
Filesystem      Size  Used Avail Use% Mounted on
udev            471M     0  471M   0% /dev
tmpfs            98M  652K   98M   1% /run
/dev/vda2        25G  2.1G   22G   9% /
tmpfs           490M     0  490M   0% /dev/shm
tmpfs           5.0M     0  5.0M   0% /run/lock
tmpfs           490M     0  490M   0% /sys/fs/cgroup
tmpfs            98M     0   98M   0% /run/user/0
```

Continue with the steps in the next section to fix this.

## Updating the filesystem on Linux

Once your server is up and running again, finish the operation by updating the filesystem.

If your Cloud Server is using the EXT4 filesystem, you can do this with the `resize2fs` command-line tool. Notice that the {partition} means the part on the disk you are expanding. Check the output of the `lsblk` command if you are unsure. For example, if your storage device is called *vda*, then your partition is probably named *vda1* or *vda2*.

```
sudo resize2fs /dev/{partition}
```

```
resize2fs 1.45.5 (07-Jan-2020)
Filesystem at /dev/vda2 is mounted on /; on-line resizing required
old_desc_blocks = 4, new_desc_blocks = 7
The filesystem on /dev/vda2 is now 13106939 (4k) blocks long.
```

Alternatively, distributions like CentOS and other RHEL derivatives might use the XFS filesystem instead of EXT4. On these servers, you will need to use the *xfs\_growfs* tool to expand the partition. Install the utility if it cannot already be found.

```
sudo dnf install xfsprogs
```

Then use the command underneath to resize your partition. Make sure to include the "/" in the command as it indicates the root directory required for the operation.

```
sudo xfs_growfs /
```

```
meta-data=/dev/vda2              isize=512    agcount=35, agsize=191935 blks
         =                       sectsz=512   attr=2, projid32bit=1
         =                       crc=1        finobt=1, sparse=1, rmapbt=0
         =                       reflink=1
data     =                       bsize=4096   blocks=6553339, imaxpct=25
         =                       sunit=0      swidth=0 blks
naming   =version 2              bsize=4096   ascii-ci=0, ftype=1
log      =internal log           bsize=4096   blocks=2560, version=2
         =                       sectsz=512   sunit=0 blks, lazy-count=1
realtime =none                   extsz=4096   blocks=0, rtextents=0
data blocks changed from 6553339 to 13106939
```

You are then done! Your filesystem should now be using all of the space allocated to the Cloud Server. You can verify this by checking the partition size with the command below.

```
df -h
```

```
Filesystem      Size  Used Avail Use% Mounted on
udev            471M     0  471M   0% /dev
tmpfs            98M  660K   98M   1% /run
/dev/vda2        50G  2.1G   46G   5% /
tmpfs           490M     0  490M   0% /dev/shm
tmpfs           5.0M     0  5.0M   0% /run/lock
tmpfs           490M     0  490M   0% /sys/fs/cgroup
tmpfs            98M     0   98M   0% /run/user/0
```

The example here demonstrates the process to extend a single 25GB storage to 50 GB. These steps are necessary when upgrading your cloud server to a higher-tier General Purpose plan, which comes with additional storage space. However, note that the process to decrease storage size is not this easy. If you are upgrading your Cloud Server only temporarily, you may wish to keep the storage size as is to be able to quickly downscale the server later on.

## Manually extending a partition on Windows

Windows servers include management tools that can help you with resizing disks at the OS level. Log into your server for example with the Remote Desktop connection.

Start by opening the *Disk Management* panel. Right-clicking the Windows start icon and selecting it from the list, or typing `diskmgmt.msc` in the search or run and then pressing enter.

The management application will indicate the unallocated space available on your disk with a black colour bar above the segment. Right-click the primary partition you wish to resize and select *Extend volume*.

![Windows extend volume](img/image-3.png)

In the wizard, the default values will extend the partition to use up all of the unallocated storage. Simply click *Next* on the first and second windows unless you wish to only extend a certain amount. On the last screen check that the values are correct and click *Finish* to confirm the changes.

![Windows extend volume wizard](img/image-4.png)

Once the requested operation is complete, the *Disk Management* panel will update to show the partition you extended now occupying the space previously unallocated. You are then done and can close the *Disk Management* window. The added storage space is ready to use with no additional restarts required.
