# Resetting root password on Linux Cloud Servers

Strong system security requires equally strong passwords, which, in turn, make the passwords more difficult to remember. In such case that the password for the Linux root user account is lost without an alternative sign-in method like an [SSH key](/docs/guides/managing-ssh-keys.md), you might end up locked out of your own system. Luckily, resetting the root password of your cloud server is fairly straightforward and will only take a few minutes to complete.

There are two ways to reset the root password of your cloud server: this method using a temporary server, or alternatively, a [Grub-based method](/docs/guides/reset-root-password-linux-grub.md) which doesn't require additional resources. Both approaches are straightforward and will only take a few minutes to complete.

## Deploying a temporary Linux host

To gain access to your old root account, you will need to be able to boot a system to a command line. A common way to do this for Linux computers is to boot into the GRUB menu, but this might prove slightly difficult on cloud servers where you have no physical access to the system. Instead, you can take advantage of the virtual nature of the cloud environment and simply create a new server to mount the old disk device in.

Start by logging into your UpCloud Control Panel and [deploying a new server](https://hub.upcloud.com/deploy).

1 - Select the same availability zone as your old server.

2 - Pick a configuration, the smallest is fine.

3 - Select whichever Linux distribution you wish. Usually, it is easiest to use the same OS as your old system.

4 - Add your SSH keys. Not highly important as you will only need to log in once.

5 - Use a simple initialization script to shut down the server after the first boot. It will save you some time as the server must be powered down to make changes to the storage.

```
shutdown -h 1
```

![Script to shutdown after deployment](img/shutdown-init-script.png)

6 - Once the setup is ready, click the *Deploy* button at the bottom of the page.

The deployment process will only take a moment, but you do not have to wait for it to complete. Continue below with the next part.

## Moving the old system disk to the temporary host

In the meanwhile, as your new server is being deployed, shut down your old server at the control panel. If the server was installed using a custom system image, you may need to use the forced shutdown command.

**[We recommend taking a backup of your server before resetting the root password](/docs/guides/taking-backups.md)**

With the server shut down, go to the *Storage* tab in your server settings.

Make sure the storage device is named so that you will be able to recognise it later. You can rename the device by clicking the *pencil* icon, entering a new name, then clicking the accept icon and afterwards the *Save changes* button to confirm.

![Rename disk](img/rename-disk-2.png)

Then, free up the OS disk device from the host by clicking the *Detach* button. If you have multiple disks, leave the other devices as they are. When attaching the OS disk again after the password reset, it will be set correctly as the first device.

![Detach storage](img/detach-storage-2.png)

Next, open the server settings of the temporary server and go to the *Storage* tab there.

Click on the *Attach existing storage* button, then find the device you just detached in the *Devices list*. Once you have selected the right disk, click the *Add a storage device* button underneath to confirm.

![Attach password reset device](img/attach-password-reset-device-2.png)

When the disk has been attached successfully, you should have two storage devices attached to the temporary server. It's original storage device as well as the one you just attached to it. Boot up the server and log in over SSH with the root user of the temporary host.

![Attach password reset device](img/attach-password-reset-device-3.png)

## Resetting the root password

When logged into the temporary server, use the `lsblk` command to check that you can see the old system disk.

```
lsblk

NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS
vda    253:0    0  25G  0 disk
├─vda1 253:1    0   1M  0 part
└─vda2 253:2    0  25G  0 part
vdb    253:16   0  25G  0 disk
├─vdb1 253:17   0   1M  0 part
└─vdb2 253:18   0  25G  0 part /
```

The first device *vda* in the above example is the system disk running the temporary server and the second *vdb* is your original system device. To access your original system data on the second storage device, you will need to mount it's main partition, which is vdb2, in the running system.

```
mount /dev/vdb2 /mnt
```

Then change to the root environment of the original system.

```
chroot /mnt
```

You can now change the root password with the usual command. Enter the new password twice to confirm.

```
passwd
```

Once you have reset the password, exit the mounting system and shut down the temporary host so that you can return the old system disk where it belongs.

```
exit

shutdown -h now
```

## Returning the system storage

When the temporary server has been powered down, you can detach the original system device in the Storage tab as you did before. Then reattach it to its original host.

![Storage reattached on the original server](img/reattached-original-server-2.png)

Then start the original server again.

You should now be able to log in using the root account with the password you just set and gain normal access to your server.

After confirming that the password was reset successfully, the temporary server and storage device can be deleted.

![Delete the temporary server](img/delete-temporary-server-2.png)
