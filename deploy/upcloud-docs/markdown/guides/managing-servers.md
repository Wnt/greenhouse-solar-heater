# Managing Cloud Servers

This article discusses managing your [Cloud Servers](https://upcloud.com/products/cloud-servers/). There are quite a few settings you can change on an existing server. However, some changes will require the server to be powered down.

First, let’s look at the Servers view. You can see the basic information of the servers and execute common operations such as restarting, shutdown etc. Shut down the server you wish to edit and then click the server line to open the settings.

![Server operations](img/server-operations-2.png)

## Server overview

In the server overview, you can see more detailed information about the server and the basic settings such as the hostname and description. Note that you can only save changes while the server is powered down.

The tabs in the server settings will let you manage different aspects of the cloud server.

![Server overview](img/server-overview-2.png)

## Console

In the Console view, you can open a console connection to the server or change the VNC connection settings. Both the console and VNC connection options can come in handy if SSH is not working for some reason. Follow up on the next guide about the different options for [connecting to your server](/docs/guides/connecting-to-your-server.md).

![Server console and VNC options](img/server-console-2.png)

## Resize

The resize options allow you to manage the resources allocated to your cloud server. You can [easily change between server plans](/docs/guides/cloud-server-plans.md) to scale the server up or down.

It’s also possible to scale up your storage disks by adding more capacity. However, the process also requires changes at the operating system level. See our guide for [resizing storage devices](/docs/guides/increasing-storage-size.md) if you want to increase or decrease the size of an existing storage disk.

![Server resize](img/server-resize-2.png)

## Backups

In the Backups section, you can take one-off instant snapshots of your server or configure automated scheduled backups. Both of these options are quick and easy to use and can save your data when the servers are backed up regularly.

We recommend taking backups as a safeguard against mistakes when making system-level configuration changes. Backups can be quickly restored to revert the server to a previous state or cloned to a new disk to allow file-level access to your backup data. Check out our guides to [taking backups](/docs/guides/taking-backups.md) and [restoring backups](/docs/guides/restoring-backups.md) to learn more.

![Server backups](img/server-backups-2.png)

## Network

The network options allow you to add or remove IP addresses on your cloud server. See the further instructions on [attaching new IP addresses](/docs/guides/attaching-new-ip-addresses.md) to learn more about the required OS-level changes when dealing with IP addresses.

![Server network details](img/server-network-2.png)

## Firewall

In the last section, you can configure the L3-level firewall service for incoming and outgoing connections. You can pick and edit the predefined rule sets or create everything as you like. Check out our more [in-depth guide to the inner workings of the firewall service](/docs/guides/managing-firewall.md).

![Server firewall options](img/server-firewall-2.png)
