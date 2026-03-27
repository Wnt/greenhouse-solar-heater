# How to manage floating IP addresses

[Our SDN](https://upcloud.com/products/software-defined-networking/) enables a transferable IP address called a floating IP that can be used to build advanced availability and redundancy. Floating IP is a static public IPv4 address that can be attached to your cloud server. It directs traffic to one server at a time and can be moved between multiple servers in a blink of an eye.

Floating IPs can be helpful in multiple ways, for example, you could perform upgrades to a copy of your production server without interrupting the service, and then transfer the floating IP to the new server when everything is ready and working. Floating IPs can also be used for redundancy in case of a system fault on your main server, or for automated failover between multiple cloud hosts.

## Attaching new floating IP

Head over to your UpCloud Control Panel to get started.

Then go to the [Floating IP addresses](https://hub.upcloud.com/networks/floating-ips) section under the Network menu.

![Floating IP addresses](img/image.png)

To continue, click the *New Floating IP* button. This will open a new configuration window.

Choose the initial cloud server and a network interface with a public IP address then click the Create Floating IP button to confirm.

![Create floating IP](img/image-1.png)

You can then see the new floating IP address attached to your cloud server.

![Floating IP created](img/image-2.png)

The new floating IP will also show in the server-specific Network menu attached to your chosen public IP network interfaces on that server.

![Server network settings](img/image-3.png)

Configure the new floating IP address on your server at the operating system level. Continue on with our guides for [CentOS](/docs/guides/configure-floating-ip-centos.md), [Debian](/docs/guides/configure-floating-ip-debian.md), [Ubuntu](/docs/guides/configure-floating-ip-ubuntu.md) or [Windows](/docs/guides/configure-floating-ip-windows.md) on how to configure the floating IP on your servers.

## Transferring floating IP

The advantage of a floating IP over regular IP addresses is the ability to transfer the IP from one server to another instantaneously. Depending on your use case, you might wish to move the floating IP address between servers at the time of your choosing. This can be easily done manually at your UpCloud Control Panel or by using the API.

Go to your UpCloud Control Panel and [Floating IP addresses](https://hub.upcloud.com/networks/floating-ips) under the Network menu.

Click the Reassign button on the IP address you wish to point to a different cloud server.

![Reassign floating IP](img/image-4.png)

Select the new server from the drop-down menu, then pick a network interface to attach to. Then click Submit to confirm.

![Reassigning floating IP](img/image-5.png)

The floating IP will then immediately begin pointing to the cloud server and interface you just selected.

If you haven’t used the floating IP on the new server before, you’ll need to perform a one-time configuration to enable traffic for [CentOS](/docs/guides/configure-floating-ip-centos.md), [Debian](/docs/guides/configure-floating-ip-debian.md), [Ubuntu](/docs/guides/configure-floating-ip-ubuntu.md) or [Windows](/docs/guides/configure-floating-ip-windows.md).

## Deleting floating IP

If you no longer have a need for a specific floating IP, you can delete it. Note that like with any other IP address, deleting one is permanent and cannot be undone. Should you wish to retain the same IP address, you should keep the floating IP without deleting it.

To start, go to your UpCloud Control Panel and [Floating IP addresses](https://hub.upcloud.com/networks/floating-ips) under the Network menu.

Find the floating IP address you wish to delete and click the Delete icon on that IP.

![Delete floating IP](img/image-6.png)

You will then be asked to confirm the deletion, and continue by clicking the Delete button.

![Deleting floating IP](img/image-7.png)

The floating IP is then removed from the server it was pointed to. However, any network interfaces configured at the OS level need to be cleared manually.
