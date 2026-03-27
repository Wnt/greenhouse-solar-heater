# How to add Floating IP on AlmaLinux 9

When you [attach a new floating IP](/docs/guides/floating-ip-addresses.md), you can find it listed to one of the servers at your UpCloud Control Panel that the floating IP currently points to. However, using the new floating IP will require some manual setup. Follow the steps below on how to get this done on Cloud Servers running AlmaLinux 9.

As an example, we have a Cloud Server with the public IP address 185.20.139.167 and a floating IP 185.20.139.29 with a netmask 255.255.255.255.

Before making changes to your network configuration, it’s always a good idea to [take a backup](/docs/guides/taking-backups.md). Also, note that if your network configuration becomes inoperable, remember that you can always log in to your Cloud Server using [the console connection](/docs/guides/connecting-to-your-server#console-connection.md).

## Configuring Floating IP

Firstly, you’ll need to configure the servers at the OS level. So start up your Cloud Server at your [UpCloud Control Panel](https://hub.upcloud.com/) and [log in](/docs/guides/connecting-to-your-server.md).

For AlmaLinux we will use NMCLI to check your current network settings with the following command.

```
nmcli con show
```

A typical response from the command would look something like the example below.

```
NAME         UUID                                  TYPE      DEVICE
System eth0  5fb06bd0-0bb0-7ffb-45f1-d6edd65f3e03  ethernet  eth0
System eth2  3a73717e-65ab-93e8-b518-24f5af32dc0d  ethernet  eth2
System eth1  9c92fad9-6ecb-3e6c-eb4d-8a47c6f50c04  ethernet  eth1
eth0         813e7c7a-dfa6-4004-9249-8938da0245a5  ethernet  --
```

Since our floating IP address is attached to the **eth0** adapter we will want to use the following command to add this to our existing adapter configuration. We can do this with the following command.

```
nmcli con mod "System eth0" +ipv4.addresses "185.20.139.29/32"
```

Then to apply the changes and re-initialise the adapter we run the command below.

```
​nmcli con up "System eth0"
```

Reactivating the public network interface should not cause you to disconnect even if you were connected over SSH. In case you do lose connection and are unable to reconnect, you can always use the web *Console* at the [UpCloud Control Panel](https://hub.upcloud.com/) under your *Server settings* to go through the setup again to make sure everything is entered correctly.

Repeat the process to add the alias on any other servers you wish to use the floating IP on.

## Testing the configuration

Your configuration is now complete. You can test that it works by transferring the floating IP from one server to another.

First, ping the Cloud Server or attempt to connect to your server through the floating IP via SSH. Alternatively, if you have a web server configured, open the floating IP on your web browser.

Then [transfer the floating IP](/docs/guides/floating-ip-addresses.md) to another Cloud Server you’ve configured. This can be done either at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api.md).

Test the floating IP again with any method you prefer. When you get a connection you have successfully transferred your floating IP.

When you get a reply, the floating IP works on that server and you can continue. If it didn’t work, make sure you entered the IP address and the command correctly, and that your firewall isn’t blocking your connections, or try another method to connect.

## Using your new Floating IP

You can now transfer the floating IP between your Cloud Servers at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api.md)!

Depending on your intended use case for the floating IP you may wish to continue by setting up automated load balancing, but it’s always possible to manually transfer the traffic between your servers.
