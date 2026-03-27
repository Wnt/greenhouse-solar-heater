# Booting a server with live CD

A live CD is a complete operating system bootable directly from portable media such as CDROMs. Rather than loading the OS from the system storage, with a live CD, you can quickly test different operating systems without having to spend the time to go through the installation process. Many Linux distributions offer downloadable disk images for creating your own live CD which can also be useful in system recovery and repair.

Running a server from a live CD requires you to create a new storage device to copy the live CD image onto, configure the storage disk as a CDROM, and then boot up your server from the CDROM device.

## Deploying a new server

Start off by creating a new cloud server of your choice at your [UpCloud Control Panel](https://hub.upcloud.com/). The instructions in this guide are directed at a Linux system but the process would be largely the same on any server OS.

Make the required configurations by:

- Selecting the location where you wish to have the live CD available
- Choose the configuration, the 1CPU and 1GB General Purpose plan works fine
- Add a second 10GB disk by clicking the text below the first.

![alt text](img/image.png)

- Pick the OS you are comfortable with for a one-time boot
- Include any SSH keys you wish if available to allow password-free login
- Naming your server and giving it a description.
- Confirm your selections and click the *Deploy* button.

Once your server has finished deploying, you can log in with SSH using any keys selected at deployment or using the root password.

## Creating a live CD storage

When logged in as a root privileged user, check that the second storage disk is available.

```
lsblk

NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINT
vda    253:0    0  25G  0 disk
└─vda1 253:1    0   1M  0 part /
└─vda2 253:2    0  25G  0 part
vdb    253:16   0  10G  0 disk
```

The first disk will show up with the regular operating system partition and the second disk should be a simple empty disk with no partitions.

Download a live CD image to the server, for example, using *curl* utility tool that is available on most distributions by default.

```
curl -o ~/image.iso https://example.com/live-cd-image.iso
```

When you have the desired live CD image saved on the server, copy the file contents to the empty storage device with the following command. Make sure that the image name and the target disk are set correctly and that the image is copied directly.

```
sudo dd if=~/image.iso of=/dev/vdb bs=16M oflag=direct
```

The copy process won’t take long.

Once the live CD image has been successfully copied to the second disk, shut down the server again either at your UpCloud Control Panel or with the command below.

```
sudo shutdown -h now
```

With the server powered down, continue on with the last steps in booting from a live CD.

## Booting from a CDROM storage

Now that you have a new live CD available, you will probably want to boot from it. This requires you to set a CDROM as the first device in the server boot order and configure the live CD storage device as CDROM.

First, go to the *Overview* tab in your server settings and scroll to the bottom of the page. Open the Optionals by clicking the text, then select *cdrom* as the first boot device and storage, as the second. Then click the *Save changes* button.

![alt text](img/image-1.png)

Next, go to the *Storage* tab in your server settings and check the second disk device you copied the live CD image.

Change the live CD storage device controller to the CDROM and click the S*ave changes* button.

![alt text](img/image-2.png)

You can then start the server and boot into your new live CD!

Depending on the live CD you might need to log into the server with either the web console at your UpCloud Control Panel or using a VNC connection. You can find more information about how to use these methods in our guide about [connecting to your server](/docs/guides/connecting-to-your-server.md).
