# How to import VMware images

If you already have a running virtual Linux host on a VMware hypervisor but would like to take advantage of the scalable hardware and MaxIOPS storage technology, it is possible to import VMware systems to UpCloud. To get your existing server running in the cloud you will need to upload the server image to a new cloud host, convert it to the RAW format, copy the converted image to a new storage drive, and reconfigure the host. This migration guide goes through each step in detail to help you transfer pre-existing virtual servers to the cloud.

**Please note that only Linux based virtual hosts can be imported. Windows Servers need to be deployed using the templates provided by UpCloud due to licensing.**

## Deploying a new server

To start off, log in to your UpCloud Control Panel and deploy a new server. You can choose whichever flavour of Linux you prefer, but for convenience, you could use the same distro as the system image you are migrating.

The new server will be used to download, convert and set up the image being imported. Consider the following when making the configurations:

- Selecting the location you wish to import the server
- Choosing the configuration (the 1CPU and 1GB General Purpose plan works fine)
- Adding a second storage disk by clicking the *Add a new device* button and choosing the size (it can be scaled up later)

  ![Deploy a new storage](img/image.png)
- Picking the OS you are comfortable with for a one-time boot
- Including any SSH keys you wish, if available, to allow password-free login
- Naming your server and giving it a description.
- Confirming your selections and click the *Deploy* button.

Once the configurations are done, hit the *Deploy server* button. Wait a few seconds for the server to start, then log into the newly deployed host to continue.

Update the system to make sure the software is running the latest versions.

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

Here the vda disk with the two partitions (*vda1* and *vda2*) is your primary storage and the *vdb* disk is the second device without partitions. If everything seems in order, continue with uploading to import the VMware system image to your cloud server.

## Importing VMware system image

Depending on your VMware hypervisor configuration the system storage disk might be stored in one or more files. The VMware virtual disk files are usually named the same as your virtual system and have a *.vmdk* file extension. You will need to copy the *.vmdk* files to the new cloud host, for example, using Secure Copy, SFTP or rsync.

You can find out about some of the different secure file transfer options in the first section Encrypt Communications in the article for [how to secure your Linux cloud server](https://upcloud.com/resources/tutorials/secure-linux-cloud-server/). Depending on your VMware system and your network connection it may be useful to compress the disk files for the transfer and then uncompress them again on the target host.

Once you have finished uploading the system image files, you will need to convert them from a VMware image to the RAW format. The file format can be converted using the *qemu-img* utility available through the package managers on most Linux distributions. With Ubuntu and other Debian-based systems, it is included in the *qemu-utils* package while on CentOS it can be installed by itself.

```
# Debian and Ubuntu
sudo apt-get install qemu-utils

# CentOS
sudo yum install qemu-img
```

With the required utilities installed, convert the VMware image to RAW format with the command below. Replace {VMware\_image} with the name of your VMware virtual disk file and the {RAW\_image} with what you wish to call the new image file.

```
qemu-img convert -f vmdk -O raw {VMware_image}.vmdk {RAW_image}.img
```

Once the conversion is complete, copy the new RAW image content to the secondary disk. Replace the {RAW\_image} with the converted disk file name just as above.

```
dd if={RAW_image}.img of=/dev/vdb bs=16M oflag=direct
```

Afterwards, you can shut down the server and remove the old primary disk. Go to your [UpCloud Control Panel](https://hub.upcloud.com/) and the Storage tab in your server settings. Once the server is in the stopped state, click the eject icon on the primary storage device to remove it. The second disk, where you just transferred the system image, will then be automatically set as the new primary device. In the same menu, you should also choose the disk controller.

![Detaching storage device](img/image-1.png)

VirtIO controller provides the best performance, but if you have issues starting the server, try IDE as it has better compatibility with different operating systems.

You can then restart the server again to continue configuring the system.

## Reconfiguring the imported system

The newly transferred operating system should now work with the cloud server. However, depending on your old network setting you may need to use the Web Console to log into the server and fix any issues before the system will connect normally. Go to your [UpCloud Control Panel](https://hub.upcloud.com/), open the *Console* tab under your server settings, and click *Open the console connection*.

Now, log in with the credentials for the imported VMware host as you did before transferring the server to the cloud. Once in, check the network settings with the following command.

```
ip addr
```

UpCloud hosts have three network interfaces in the default configuration, public IPv4, private IPv4 and public IPv6 addresses, you might see something similar to the example output below. Here the first interface eth0 is working but the other devices are not yet configured.

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

Edit your network configuration files to match the network interface names listed in the command output. For example on Ubuntu and other Debian-based systems use the command below to open the configuration file.

```
sudo nano /etc/network/interfaces
```

Add the following sections to the file. If the network interfaces on your server are named differently, use those names instead of *eth0*, *eth1*, etc.

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

Congratulations, your imported VMware system should now be up and running on a brand new cloud host. In case you have any further problems with the network, you can find additional help with troubleshooting the connectivity in the guide about [network issues with the Linux host](https://upcloud.com/resources/tutorials/troubleshoot-network-connectivity-linux-server/).

Also, if you run into issues with booting from the migrated system image, you can always attach the old primary disk again and find the uploaded VMware disk stored safely for another try without the need to wait for the image to upload again. Once you are confident that the imported system is running properly, you can go to the Storage menu in your [UpCloud Control Panel](https://hub.upcloud.com/) and delete the unnecessary storage device.
