# Managing floating IPs using the UpCloud API

[Our SDN](https://upcloud.com/products/software-defined-networking/) enables a transferable IP address called a floating IP that can be used to build advanced availability and redundancy. Floating IP is a static public IPv4 address that can be attached to your cloud server. It directs traffic to one server at a time and can be moved between multiple servers in a blink of an eye.

Using the UpCloud API to manage your floating IP addresses allows you to perform all necessary operations programmatically and automate failover. In this guide, we’ll show you how to attach new floating IP addresses, transfer them on request, and delete the IPs once they are no longer needed.

If you are not yet familiar with the UpCloud API, we would suggest taking a quick look at our guide to [getting started with UpCloud API](/docs/guides/getting-started-upcloud-api.md) to set up your API user account and access rights.

## Attaching a new floating IP

When a new floating IP is created and attached, the target cloud server needs to be shut down.

Begin by shutting down one of the cloud servers on which you wish to use the floating IP address. Only one of the servers must be shut down while a new floating IP is attached.

```
POST /1.3/server/server_UUID/stop
```

Replace the IP address highlighted below with the floating IP you wish to attach to a new cloud server, and then enter the MAC address of the network interface on the target. You can find the MAC address in your cloud server details by querying the API with the target UUID.

```
GET /1.3/server/server_uuid
```

Then, create and attach a new IP address defined by setting the floating property to yes.

```
POST /1.3/ip_address

{
  "ip_address": {
    "family": "IPv4",
    "mac": "mm:mm:mm:mm:mm:m1",
    "floating": "yes"
  }
}
```

You must also configure the floating IP at the operating system level. You can find instructions in our guides for [CentOS](/docs/guides/configure-floating-ip-centos.md), [Debian](/docs/guides/configure-floating-ip-debian.md), [Ubuntu](/docs/guides/configure-floating-ip-ubuntu.md), or [Windows](/docs/guides/configure-floating-ip-windows.md) on how to configure the floating IP on your servers.

## Transferring an existing floating IP

The advantage of floating IP over regular IP addresses is the ability to transfer the IP from one server to another instantaneously. Depending on your use case, you might wish to move the floating IP address between servers at your chosen time or by configuring automation.

Transferring a floating IP address using the UpCloud API is simple. While attaching a floating IP for the first time requires shutting down the target cloud server, transferring an existing address also works with running cloud servers.

First, you need to know the network interface MAC address to which you wish to transfer the floating IP. For example, you can find the MAC address in your cloud server details by querying the API with the target server’s UUID.

```
GET /1.3/server/server_uuid
```

Then, use the following command to transfer the floating IP. Replace the IP address highlighted below with the floating IP address you wish to attach to a new cloud server, and then enter the MAC address of the network interface on the target.

```
PATCH /1.3/ip_address/0.0.0.0

{
  "ip_address": {
    "mac": "mm:mm:mm:mm:mm:m1"
  }
}
```

If you haven’t yet used the floating IP on the new cloud server, you will also need to configure the floating IP at the operating system level. You can find instructions in our guides for [CentOS](/docs/guides/configure-floating-ip-centos.md), [Debian](/docs/guides/configure-floating-ip-debian.md), [Ubuntu](/docs/guides/configure-floating-ip-ubuntu.md) or [Windows](/docs/guides/configure-floating-ip-windows.md) on how to configure the floating IP on your servers.

It’s also possible to do this directly from the target cloud server if, for example, it notices a failure in the current server the floating IP is pointing to.

```
#!/bin/bash

# Export your UpCloud credentials to the environmental variables
# export UPCLOUD_USERNAME=username
# export UPCLOUD_PASSWORD=password

# Enter the floating ip address you want to attach
ip=0.0.0.0
# Select the target network interface, commonly eth0
interface=eth0

# API command to transfer the floating IP
curl -u "$UPCLOUD_USERNAME:$UPCLOUD_PASSWORD" -X PATCH
-H Content-Type:application/json https://api.upcloud.com/1.3/ip_address/$ip
--data-binary '{"ip_address":{"mac":"'`cat /sys/class/net/$interface/address`'"}}'
```

Then, execute the script whenever you need the floating IP transferred. This allows you to redirect traffic or even automate failover quickly.

## Detaching a floating IP

Detaching a floating IP without attaching it to another interface, pass an explicit null or empty string as a mac value.

Replace the IP address highlighted below with the floating IP you wish to detach.

```
PATCH /1.3/ip_address/0.0.0.0

{
  "ip_address": {
    "mac": null
  }
}
```

Detaching a floating IP allows you to retain the IP address even if you wish to delete the servers it was used on. You might also wish to detach a floating IP while in use to stop traffic to the address in case of, e.g., a DDoS attack.

## Deleting a floating IP

Use the following command to delete any IP address. The deletion is permanent and cannot be reversed.

Replace the IP address highlighted below with the floating IP you wish to delete.

```
DELETE /1.3/ip_address/0.0.0.0
```

If you delete an IP address by mistake, immediately attaching a new IP of the same type may give you the IP that was just released if it has not been attached anywhere else.
