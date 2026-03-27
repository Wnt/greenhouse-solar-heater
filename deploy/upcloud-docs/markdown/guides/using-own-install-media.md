# Using your own installation media

Although we offer several different operating system images and CDROMs at the UpCloud Control Panel, you might want to install an operating system from your own installation media. This process requires you to create storage that contains the install image, define it as a CDROM at the control panel and then boot up the server from that CDROM storage.

In this guide, we’ll show you how to manually create your own install media from any storage image. However, we have also automated much of this process with our [Storage Import](/docs/guides/storage-import.md) feature.

Note that only most Unix-based operating systems are currently supported.

## Deploying a new server

Start off by creating a new cloud server of your choice at your [UpCloud Control Panel](https://hub.upcloud.com/). The instructions in this guide are directed at a Linux system but the process would be largely the same on any server OS.

Make the required configurations by:

- Selecting the location you wish to have the live CD available
- Choosing the configuration (the 1CPU and 1GB General Purpose plan works fine)
- Adding a second 10GB disk by clicking the *Add a new device* button

  ![New install media server](img/image.png)
- Picking the OS you are comfortable with for a one-time boot
- Including any SSH keys you wish, if available, to allow password-free login
- Naming your server and giving it a description.
- Confirming your selections and clicking the *Deploy* button.

Once your server has finished deploying, you can log in with SSH using any keys selected at deployment or by using the one-time password.

## Preparing the installation media

When logged in, check that you have the storage space required to continue with the command underneath.

```
lsblk
```

```
NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINT
vda    253:0    0  25G  0 disk
└─vda1 253:1    0   1M  0 part /
└─vda2 253:2    0  25G  0 part
vdb    253:16   0  10G  0 disk
```

The first disk will show up with the regular operating system partition which is mounted at the root and the second disk should be a simple empty disk with no partitions.

Download the installation image you wish to use to the server, for example using curl and wait for the download to finish.

```
curl -o ~/image.iso https://example.com/install-image.iso
```

When you have the desired image saved on the server, copy the file contents to the empty storage device with the following command. Check that the image name and the target disk are set correctly and that the image is copied directly.

```
dd if=~/image.iso of=/dev/vdb bs=16M oflag=direct
```

This operation is quite fast and when the image file has been copied to the storage, shut down the server either from your UpCloud Control Panel or with the command below.

```
shutdown -h now
```

Once the server has powered down, go to the Overview tab in your server settings and scroll to the bottom of the page. Open the *Optionals* by clicking the text, then select *cdrom* as the first boot device and click the *Save changes button*.

![Changing the system boot order](img/image-1.png)

Next, go to the *Storage* tab in your server settings and check the second disk device you set up with the install media.

Change the storage device controller to CDROM and click the *Save changes button*.

![Set install media as CDROM](img/image-2.png)

This will tell the server to boot up from the media disk so that you may start the installation.

## Installing from the image media

You can now start the server again and go through the installation process with the disk image you downloaded. You will need to use either the web console at your server settings or a VNC connection to access the server during the installation. You can find more information about how to use these methods in our guide for [connecting to your server](/docs/guides/connecting-to-your-server#console-connection.md).

When you have finished installing the new operating system, shut down the server again and detach or delete the installation device from the Storage list. You may also wish to create a [template of the newly installed server](/docs/guides/custom-server-images.md) in the Storage list.
