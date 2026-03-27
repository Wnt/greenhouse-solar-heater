# How to configure Floating IP on Windows

When you attach a new floating IP, you can find it listed to one of the servers at your UpCloud Control Panel that the floating IP currently points to. However, using the new floating IP will require some manual setup. Follow the steps below on how to get this done on Ubuntu servers.

As an example, we have a cloud server with the public IP address 185.20.139.167, a floating IP 185.20.139.29, with a netmask 255.255.255.255.

Before making changes to your network configuration, it’s always a good idea to [take a backup](/docs/guides/taking-backups.md). Also, note that if your network configuration becomes inoperable, remember that you can always log in to your cloud server using [the console connection](/docs/guides/connecting-to-your-server#console-connection.md).

## Setting up a static IP address

Firstly, you’ll need to configure the servers at the OS level, so start up your servers at your [UpCloud Control Panel](https://hub.upcloud.com/) and [log in](/docs/guides/connecting-to-your-server.md).

Windows servers need to set a network interface for the floating IP to static either through the network settings properties or by using netsh on the command prompt. For public floating IPs, the right interface for this is the primary public IPv4 adapter, often named simply Ethernet.

Next, check the network connection name. Open the Windows Command Prompt as administrator (cmd on run) and enter the following command.

```
netsh interface ip show config
```

If you are configuring a public floating IP, find the network adapter with your public IPv4 address. It is usually called “Ethernet” like in the example output below.

```
Configuration for interface "Ethernet"
   DHCP enabled:                         Yes
   IP Address:                           185.20.139.167
   Subnet Prefix:                        185.20.136.0/22 (mask 255.255.252.0)
   Default Gateway:                      185.20.136.1
   Gateway Metric:                       0
   InterfaceMetric:                      5
   DNS servers configured through DHCP:  94.237.127.9
                                         94.237.40.9
   Register with which suffix:           Primary only
   WINS servers configured through DHCP: None
```

Once you’ve identified the right network interface and found your IP information, use the next command by giving the network\_adapter, ip\_address, netmask and gateway. This will set the interface to static configuration.

```
netsh interface ip set address "network_adapter" static ip_address netmask gateway
```

For this public floating IP example setup, on server 1 the command would be the following.

```
netsh interface ip set address "Ethernet" static 185.20.139.167 255.255.252.0 185.20.136.1
```

Your remote desktop connection might get interrupted for a few seconds while changes are being applied but should reconnect shortly. In case you do lose connection and are unable to reconnect, you can always use the web *Console* at the [UpCloud Control Panel](https://hub.upcloud.com/) under your server settings to go through the setup again to make sure everything is entered correctly.

After setting a public IP address to static you will need to add at least one domain name server. Use the command below to add the DNS addresses as shown in the interface configuration output to the same network adapter as you set the static IP.

```
netsh interface ip add dns "Ethernet" 94.237.127.9
netsh interface ip add dns "Ethernet" 94.237.40.9 index=2
```

Repeat the steps on your other server you wish to use the floating IP on to configure them with static IP and DNS addresses as well.

## Configuring the floating IP

To enable the floating IP, you need to add it as an alias to the NIC with your static IP. Start by checking which of your servers the floating IP is attached to. You will see the floating IP as an additional IP address under your  *Networks* tab in the [UpCloud Control Panel](https://hub.upcloud.com/networks). Configured the floating IP on that server as instructed below.

Windows has the option to add an alias IP address to your primary network connection through the advanced properties, but the simplest way is to use netsh on the command prompt. If you have multiple Windows systems you wish to use the floating IP on, only add it to one server at a time.

On the server that the floating IP is attached to, Windows has likely created a new network interface that is reserving the address. Check the list of network adapters and find the interface with the floating IP. Make note of the name of the interface and disable it with the following command on the Command Prompt. This only applies to the first server.

```
netsh interface set interface "network_adapter" disable
```

Next, use the command below while replacing the network\_adapter, floating\_ip and netmask with the information specific to your server.

```
netsh -c interface ip add address name="network_adapter" addr=floating_ip mask=netmask
```

For example with a public floating IP, the command would be the following.

```
netsh -c interface ip add address name="Ethernet" addr=185.20.139.29 mask=255.255.255.255
```

Repeat the process to add the alias on any other servers you wish to use the floating IP on.

## Testing the configuration

Your configuration is now complete. You can test that it works by transferring the floating IP from one server to another.

The first attempt to connect to your server through the floating IP with Remote Desktop Connection. Or if you have a web server configured, open the floating IP on your web browser.

Then transfer the floating IP to another cloud server you’ve configured. This can be done either at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api.md).

Test the floating IP again with any method you prefer. When you get a connection you have successfully transferred your floating IP.

Note that the Windows Firewall blocks inbound ICMP requests used by ping, allow these if you wish to test the floating IP with ping.

When you get a reply, the floating IP works on that server and you can continue forward. If it didn’t work, make sure you entered the IP address and netmask correctly, and that your firewall isn’t blocking your connections, or try another method to connect.

## Using your new floating IP

You can now transfer the floating IP between your cloud servers at your [UpCloud Control Panel](https://hub.upcloud.com/networks/floating-ips) or by using the [UpCloud API](/docs/guides/managing-floating-ips-upcloud-api.md)!

Depending on your intended use case for the floating IP you may wish to continue by setting up automated load balancing, but it’s always possible to manually transfer the traffic between your servers.
