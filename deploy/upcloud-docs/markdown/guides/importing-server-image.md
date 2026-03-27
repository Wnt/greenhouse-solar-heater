# Importing your own server image

If you already have a server image that you would like to use on top of UpCloud’s infrastructure, you can create bootable OS storage from it. The process requires that you deploy a new server, upload the image to the cloud host and set up the new disk device. This guide goes through the process step-by-step.

## Deploying a new host

Start off by creating a new cloud server of your choice at your [UpCloud Control Panel](https://hub.upcloud.com/). The instructions in this guide are directed at a Linux system but the process would be largely the same on any server OS.

Make the required configurations by:

- Selecting the location you wish to import the server
- Choosing the configuration (the 1CPU and 1GB General Purpose plan works fine)
- AAdding a second storage disk by clicking the "Add a new device" button and choosing the size (it can be [scaled up later](/docs/guides/increasing-storage-size.md))

  ![Deploy a new storage](img/image.png)
- Picking the OS you are comfortable with for a one-time boot
- Including any SSH keys you wish, if available, to allow password-free login
- Naming your server and giving it a description
- Confirming your selections and clicking the *Deploy* button

Once your server has finished deploying, you can log in with SSH using any keys selected at deployment or using the root password.

Update the system to make sure the software is running the latest version.

```
# Debian and Ubuntu
sudo apt-get update && sudo apt-get dist-upgrade -y

# CentOS
sudo yum update -y
```

With the new server up to date, check that both of the storage drives are attached and report their size correctly.

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

Here the *vda* disk with a partition called vda2 is your primary storage and the vdb disk is the second device without partitions. If everything seems in order, continue with uploading your server image to the cloud host.

## Importing the system image

When the new host is up and ready, upload your server image, for example using Secure Copy, SFTP or rsync.

You can find out about some of the different secure file transfer options in the first section for Encrypt communications in the [guide for cloud server security](https://upcloud.com/resources/tutorials/secure-linux-cloud-server/). Depending on your original system and your network connection it may be useful to compress the disk files for the transfer and then uncompress them again on the target host.

When you have uploaded the image to the server, you will need to copy the image content to the empty storage device. Use the following command while replacing the `<server_image>` with the system image file, the target disk is usually located at /dev/vdb.

```
dd if=<server_image> of=/dev/vdb bs=16M oflag=direct
```

Note that the server image needs to be in RAW format ending with the *.img* file extension. This means images taken, for example, from a VMware environment do not work as is. The VMware images should be converted to the RAW format with a tool such as qemu-img, which is available for installation on most package managers. Check out our guide about how to [import VMware images to UpCloud](/docs/guides/import-vmware-images.md) to learn more.

Afterwards, you can shut down the server and remove the old primary disk. Go to your [UpCloud Control Panel](https://hub.upcloud.com/) and the Storage tab at your server settings. Once the server is in the stopped state, click the eject icon on the primary storage device to remove it. The second disk, where you just transferred the system image, will then be automatically set as the new primary device. In the same menu, you should also choose the disk controller.

![Detaching storage device](img/image-1.png)

VirtIO controller provides the best performance, but if you have issues starting the server, try IDE as it has better compatibility with different operating systems.

You can then restart the server again to continue configuring the system.

## Reconfiguring the new host

The newly transferred operating system should now boot up to the cloud server. However, depending on your old network setting you may need to log in using the web console to fix any issues before the system will connect normally. Go to your [UpCloud Control Panel](https://hub.upcloud.com/) then select the *Console* tab under your server settings and click *Open the console connection*.

Log in normally with the user credentials for the server image before transferring it to the cloud. Once in, check the network settings with the following command.

```
ip addr
```

UpCloud hosts have three network interfaces in the default configuration, public IPv4, private IPv4 and public IPv6 addresses. You might see something similar to the example output below. The first interface eth0 might work but the other devices are not yet configured.

```
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default
 link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
 inet 127.0.0.1/8 scope host lo
 valid_lft forever preferred_lft forever
 inet6 ::1/128 scope host
 valid_lft forever preferred_lft forever
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000
 link/ether 6e:d7:1b:bf:18:29 brd ff:ff:ff:ff:ff:ff
 inet 83.136.248.62/22 brd 83.136.251.255 scope global eth0
 valid_lft forever preferred_lft forever
 inet6 fe80::6cd7:1bff:febf:1829/64 scope link
 valid_lft forever preferred_lft forever
3: eth1: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000
 link/ether 6e:d7:1b:bf:e6:f2 brd ff:ff:ff:ff:ff:ff
4: eth2: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000
 link/ether 6e:d7:1b:bf:61:a8 brd ff:ff:ff:ff:ff:ff
```

Edit your network configuration files to match the network interface names listed in the above output. For example, Ubuntu and other Debian-based systems use the command below to open the configuration file.

```
sudo nano /etc/network/interfaces
```

Add the following sections to the file. If the network interfaces were named differently, use those names instead of *eth0*, *eth1*, etc.

```
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp

auto eth1
iface eth1 inet dhcp

auto eth2
iface eth2 inet6 auto
```

On CentOS and other Red Hat variants, the network interfaces are configured in individual files. These files are stored in the `/etc/sysconfig/network-scripts/` directory, check the file names with the command below.

```
ls /etc/sysconfig/network-scripts/ | grep ifcfg-
```

Then open the first interface file for editing, for example, *ifcfg-eth0*.

```
sudo vi /etc/sysconfig/network-scripts/ifcfg-eth0
```

The file should read at least the following settings. In case, *ONBOOT* is set to *no*, change it to *yes* and save the file.

```
DEVICE=eth0
BOOTPROTO=dhcp
ONBOOT=yes
```

You may need to do the same operation to other network interfaces, or simply create new configuration files if your old system only had one or two interfaces.

Afterwards, reboot the server and try logging in with SSH. If the network is working you can start using the new host as before with the added benefit of the freely scalable system resources and faster than SSD storage disks with MaxIOPS technology.

## Final steps

Congratulations, your own server image should now be up and running on a brand new cloud host. In case you have any further problems with the network, you can find additional help with troubleshooting the connectivity in the guide for [network issues with the Linux host](https://upcloud.com/resources/tutorials/troubleshoot-network-connectivity-linux-server/).

If you run into issues with booting from the new system image, you can always attach the old primary disk again and find the image files safely stored for another try without the need to wait for the image to upload again. Once you are confident that the new system is running properly, you can go to the Storage list in your [UpCloud Control Panel](https://hub.upcloud.com/) and delete the unnecessary storage device.
