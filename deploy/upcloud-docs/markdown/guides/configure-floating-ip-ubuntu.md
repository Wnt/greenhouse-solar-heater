# How to configure Floating IP on Ubuntu

When you attach a new floating IP, you can find it listed to one of the servers at your UpCloud Control Panel that the floating IP currently points to. However, using the new floating IP will require some manual setup. Follow the steps below on how to get this done on Ubuntu servers.

As an example, we have a Cloud Server with the public IP address 185.20.139.167, a floating IP 185.20.139.29, with a netmask 255.255.255.255.

Before making changes to your network configuration, it’s always a good idea to [take a backup](/docs/guides/taking-backups.md). Also, note that if your network configuration becomes inoperable, remember that you can always log in to your Cloud Server using [the console connection](/docs/guides/connecting-to-your-server#console-connection.md).

## Configuring floating IP

Firstly, you’ll need to configure the servers at the OS level, so start up your Cloud Server at your [UpCloud Control Panel](https://hub.upcloud.com/) and [log in](/docs/guides/connecting-to-your-server.md).

Check your current network settings with the following command.

```
ip addr
```

Commonly the second network interface card (NIC) named eth0 has your public IPv4 address assigned to it, see the example below.

```
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 6e:d7:1b:bf:5a:b0 brd ff:ff:ff:ff:ff:ff
    inet 185.20.139.167/22 brd 80.69.175.255 scope global eth0
    valid_lft forever preferred_lft forever
```

Now, to enable the floating IP, add it as an alias to the network interface eth0 that has your public IP address.

### Ubuntu 22 and later

Since the release of Ubuntu 22, the OS has been using netplan which changes how the network interfaces are configured.

Create the following file in the netplan configuration directory with the command below.

```
sudo nano /etc/netplan/99-floating-ip.yaml
```

```
network:
    version: 2
    renderer: networkd
    ethernets:
        eth0:
            addresses:
                - 185.20.139.29/32
```

Then save the file and exit the editor.

Lastly, apply the changes with the following command.

```
sudo netplan apply
```

Afterwards, you should be able to see the floating IP attached to the eth0 network interface.

```
ip addr
```

```
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether 6e:d7:1b:bf:0a:c7 brd ff:ff:ff:ff:ff:ff
    altname enp0s3
    altname ens3
    inet 185.20.139.29/32 scope global eth0
       valid_lft forever preferred_lft forever
     inet 185.20.139.167/22 brd 80.69.175.255 scope global dynamic eth0
       valid_lft 67261sec preferred_lft 67261sec
    inet6 fe80::6cd7:1bff:febf:ac7/64 scope link
       valid_lft forever preferred_lft forever
```

Applying the changes should not cause you to disconnect from the server.

In case you do lose connection and are unable to reconnect, you can always use the web *Console* at [UpCloud Control Panel](https://hub.upcloud.com/) under your *Server settings* to go through the setup again to make sure everything is entered correctly.

**Repeat the process to add the alias on any other servers you wish to use the floating IP on.**

### Ubuntu 20 and earlier

On Ubuntu 20 and earlier, adding an alias network interface can be done by adding eth0:1 to the interfaces file.

```
sudo nano /etc/network/interfaces
```

Enter the example configuration shown below with your floating IP and netmask. The address highlighted below is an example, replace it with your floating IP.

```
auto eth0:1
iface eth0:1 inet static
address 185.20.139.29
netmask 255.255.255.255
```

Save the file and exit after these changes.

Finally, restart the network manager to enable the new configuration.

```
sudo systemctl restart networking
```

If you were connected with SSH, the networking restart should not cause you to disconnect.

In case you do lose connection and are unable to reconnect, you can always use the web *Console* at [UpCloud Control Panel](https://hub.upcloud.com/) under your *Server settings* to go through the setup again to make sure everything is entered correctly.

**Repeat the process to add the alias on any other servers you wish to use the floating IP on.**

## Testing the configuration

Your configuration is now complete. You can test that it works by transferring the floating IP from one server to another.

First, ping the cloud server or attempt to connect to your server through the floating IP via SSH. Alternatively, if you have a web server configured, open the floating IP on your web browser.

Then transfer the floating IP to another cloud server you’ve configured. This can be done either at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api#transferring-an-existing-floating-ip.md).

Test the floating IP again with any method you prefer. When you get a connection you have successfully transferred your floating IP.

When you get a reply, the floating IP works on that server and you can continue forward. If it didn’t work, make sure you entered the IP address and netmask correctly, and that your firewall isn’t blocking your connections, or try another method to connect.

## Using your new floating IP

You can now transfer the floating IP between your cloud servers at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api#transferring-an-existing-floating-ip.md)!

Depending on your intended use case for the floating IP you may wish to continue by setting up automated load balancing, but it’s always possible to manually transfer the traffic between your servers.
