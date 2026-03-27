# How to configure Floating IP on Debian

When you attach a new floating IP, you can find it listed to one of the servers at your UpCloud Control Panel that the floating IP currently points to. However, using the new floating IP will require some manual setup. Follow the steps below on how to get this done on Debian servers.

As an example, we have a Cloud Server with the public IP address 185.20.139.167, a floating IP 185.20.139.29, with a netmask 255.255.255.255.

Before making changes to your network configuration, it’s always a good idea to [take a backup](/docs/guides/taking-backups.md). Also, note that if your network configuration becomes inoperable, remember that you can always log in to your Cloud Server using [the console connection](/docs/guides/connecting-to-your-server#console-connection.md).

## Configuring floating IP

Firstly, you'll need to configure the server at the OS level, so start up your Cloud Server at your UpCloud Control Panel and [connect to it via SSH](/docs/guides/connecting-to-your-server.md)..

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

The configuration process differs depending on your Debian version, as different versions use different network management approaches.

### Debian 12 and later

Debian 12 uses cloud-init to manage network configuration, so you'll need to edit the cloud-init generated file and then disable automatic network management.

First, add the floating IP alias configuration to the cloud-init network file.

```
sudo nano /etc/network/interfaces.d/50-cloud-init
```

Add the following configuration at the end of the file. Replace the address with your floating IP.

```
auto eth0:1
iface eth0:1 inet static
address 185.20.139.29
netmask 255.255.255.255
```

Save the file and exit the editor.

Next, prevent cloud-init from overwriting your changes by creating a disable file.

```
sudo nano /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
```

Add the following line to the file.

```
network: {config: disabled}
```

Save the file and exit the editor.

Finally, restart the network manager to enable the new configuration.

```
sudo systemctl restart networking
```

### Debian 11 and earlier

Add the floating IP as an alias to the network interface eth0 that has your public IP address by editing the interfaces file.

```
sudo nano /etc/network/interfaces
```

Enter the configuration shown below with your floating IP and netmask. Replace the address with your floating IP.

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

### Completing the setup

If you were connected with SSH, the networking restart should not cause you to disconnect.

In case you do lose connection and are unable to reconnect, you can always use the web *Console* at your UpCloud Control Panel under your *Server settings* to go through the setup again to make sure everything is entered correctly.

Repeat the process to add the alias on any other servers you wish to use the floating IP on.

## Testing the configuration

Your configuration is now complete. You can test that it works by transferring the floating IP from one server to another.

First, ping the cloud server or attempt to connect to your server through the floating IP via SSH. Alternatively, if you have a web server configured, open the floating IP on your web browser.

Then transfer the floating IP to another cloud server you’ve configured. This can be done either at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api#transferring-an-existing-floating-ip.md).

Test the floating IP again with any method you prefer. When you get a connection you have successfully transferred your floating IP.

When you get a reply, the floating IP works on that server and you can continue forward. If it didn’t work, make sure you entered the IP address and netmask correctly, and that your firewall isn’t blocking your connections, or try another method to connect.

## Using your new floating IP

You can now transfer the floating IP between your cloud servers at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api#transferring-an-existing-floating-ip.md)!

Depending on your intended use case for the floating IP you may wish to continue by setting up automated load balancing, but it’s always possible to manually transfer the traffic between your servers.
