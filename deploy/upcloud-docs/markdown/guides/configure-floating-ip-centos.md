# How to configure Floating IP on CentOS

When you attach a new floating IP, you can find it listed to one of the servers at your UpCloud Control Panel that the floating IP currently points to. However, using the new floating IP will require some manual setup. Follow the steps below on how to get this done on Ubuntu servers.

As an example, we have a cloud server with the public IP address 185.20.139.167, a floating IP 185.20.139.29, with a netmask 255.255.255.255.

Before making changes to your network configuration, it’s always a good idea to [take a backup](/docs/guides/taking-backups.md). Also, note that if your network configuration becomes inoperable, remember that you can always log in to your cloud server using [the console connection](/docs/guides/connecting-to-your-server#console-connection.md).

## Configuring floating IP

Firstly, you’ll need to configure the servers at the OS level, so start up your cloud server at your [UpCloud Control Panel](https://hub.upcloud.com/) and [log in](/docs/guides/connecting-to-your-server.md).

Check your current network settings with the following command.

```
ip addr
```

Commonly the second network interface card (NIC) named eth0, highlighted below, has your public IPv4 address assigned to it.

```
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP qlen 1000
   link/ether 6e:d7:1b:bf:3a:5f brd ff:ff:ff:ff:ff:ff
   inet 185.20.139.167/22 brd 185.20.139.255 scope global eth0
      valid_lft 53810sec preferred_lft 53810sec
```

On CentOS hosts, each NIC is controlled by its own configuration file. You will need to create a new network interface configuration file for the floating IP. The easiest way to do this is to duplicate the configuration file of the NIC with your regular IP, this way you don’t need to write the whole file from scratch.

For example, with *eth0* you can use the following command.

```
sudo cp /etc/sysconfig/network-scripts/ifcfg-eth0 /etc/sysconfig/network-scripts/ifcfg-eth0:1
```

Then edit the new alias interface.

```
sudo vi /etc/sysconfig/network-scripts/ifcfg-eth0:1
```

Add the same “*:1*” to the *device* name, enter a new parameter *NM\_CONTROLLED=no*, replace the IP address with the floating IP and then remove the *gateway* line.

```
DEVICE=eth0:1
BOOTPROTO=static
ONBOOT=yes
NM_CONTROLLED=no
IPADDR=185.20.139.29
NETMASK=255.255.255.255
```

Save the file and exit after these changes.

Finally, restart your network manager to enable the changes.

```
# CentOS 7
sudo systemctl restart network
# CentOS 8
sudo systemctl restart NetworkManager
```

If you were connected with SSH, the networking restart should not cause you to disconnect. In case you do lose connection and are unable to reconnect, you can always use the web *Console* at th[e UpCloud Control Panel](https://hub.upcloud.com/) under your *Server settings* to go through the setup again to make sure everything is entered correctly.

Repeat the process to add the alias on any other servers you wish to use the floating IP on.

## Testing the configuration

Your configuration is now complete. You can test that it works by transferring the floating IP from one server to another.

First, ping the cloud server or attempt to connect to your server through the floating IP via SSH. Alternatively, if you have a web server configured, open the floating IP on your web browser.

Then transfer the floating IP to another cloud server you’ve configured. This can be done either at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api.md).

Test the floating IP again with any method you prefer. When you get a connection you have successfully transferred your floating IP.

When you get a reply, the floating IP works on that server and you can continue forward. If it didn’t work, make sure you entered the IP address and netmask correctly, and that your firewall isn’t blocking your connections, or try another method to connect.

## Using your new floating IP

You can now transfer the floating IP between your cloud servers at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api.md)!

Depending on your intended use case for the floating IP you may wish to continue by setting up automated load balancing, but it’s always possible to manually transfer the traffic between your servers.
