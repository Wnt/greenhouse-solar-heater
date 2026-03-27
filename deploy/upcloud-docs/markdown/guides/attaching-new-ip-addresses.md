# Attaching new IP addresses

You can attach additional network interfaces to your UpCloud server for both public and private networks. Start by shutting down your server, then head over to your server's Network tab in the [UpCloud Control Panel](https://hub.upcloud.com/)

## Adding network interfaces

While the server is powered down, click the Create interface button to add a new network interface. The process differs slighlty depending on whether you're adding a public or private interface.

![UpCloud Control Panel Network tab showing existing network interfaces and the Create interface button with dropdown menu displaying Public network interface, Private network interface, and Utility network interface options](network-interfaces-overview.png)

### Public network interfaces

You can have up to five public IPv4 and five public IPv6 addresses on your server.

From the interface type dropdown, select Public network interface. Choose the type of address you want, public IPv4 or IPv6.
In the IP address dropdown, select Create new public IP to generate a new address, or choose an existing Floating IP if you have one available. You can leave the Index field empty for automatic assignment.

![Create public interface dialog showing address type selection with Public IPv4 selected, IP address dropdown set to Create new public IP, Index field for custom assignment, and Create/Cancel buttons with monthly pricing information](create-public-interface-dialog.png)

Click Create to attach the new address. You’ll get a confirmation notification and the new address will appear in your network interfaces list.

**Important:** After attaching the public interface, there are some operations that must be done at the OS level in order for the system to become aware of the changes. See the OS-specific instructions below.

### Private network interfaces

There is no limit on the number of private IP addresses you can attach to your server.

From the interface type dropdown, select Private network interface.
Choose a network from the dropdown - you can select an existing SDN network or click Create new SDN network to set up a new private network.
Set the IP address allocation method:

- **DHCP**: Automatically assigns an IP address from the network's range
- **Manual IP address**: Lets you specify a particular IP address

The Enable source IP filtering option controls whether the interface filters packets based on source IP addresses - leave this enabled unless the server will act as a gateway.

![Create private interface dialog showing network selection dropdown with an existing SDN Network selected, IP address allocation options with DHCP selected, Enable source IP filtering toggle enabled, and Create interface/Cancel buttons](create-private-interface-dialog.png)

Click Create to attach the new private interface. You’ll get a confirmation notification and the new address will appear in your network interfaces list.

**Important:** After attaching the private interface, there are some operations that must be done at the OS level in order for the system to become aware of the changes. See the OS-specific instructions below.

## Operating system configuration

### Ubuntu 22 and later

Connect to your Cloud Server. Once in, you’ll need to add a new interface configuration. Since the release of Ubuntu 22, the OS has been using netplan which changes how the network interfaces are configured.

First, check the new network interface name with the command below. The new interface will be the last on the list without an IP, eth3 in the example below.

```
ip addr
```

```
5: eth3: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000
    link/ether 6e:d7:1b:bf:3b:cf brd ff:ff:ff:ff:ff:ff
    altname enp0s5
    altname ens5
```

Next, create a new network configuration file and add the following content. Make sure you name the interface correctly.

```
sudo nano /etc/netplan/60-eth3.yaml
```

```
network:
    version: 2
    renderer: networkd
    ethernets:
        eth3:
            dhcp4: true
```

If you are adding an IPv6, the syntax is a little different, use the following instead.

```
network:
    version: 2
    renderer: networkd
    ethernets:
        eth3:
            dhcp6: true
```

Then save the file and exit the editor.

Lastly, apply the changes.

```
sudo netplan apply
```

If the changes were applied successfully, you should now be able to see the new IP address.

```
ip addr show dev eth3
```

```
5: eth3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether 6e:d7:1b:bf:3b:cf brd ff:ff:ff:ff:ff:ff
    altname enp0s5
    altname ens5
    inet 94.237.59.222/22 metric 100 brd 94.237.59.255 scope global dynamic eth2
       valid_lft 86396sec preferred_lft 86396sec
    inet6 fe80::6cd7:1bff:febf:3bcf/64 scope link
       valid_lft forever preferred_lft forever
```

Once you see the new interface at the end of the list like in the example above you’ve successfully configured a new IP address to your Cloud Server. It can now be used to connect to the host just like the other addresses.

### Debian 12 and later

Connect to your Cloud Server. Debian 12 uses cloud-init to manage network configuration, so you'll need to edit the cloud-init generated file and then disable automatic network management.

First, add the new interface configuration to the cloud-init network file.

```
sudo nano /etc/network/interfaces.d/50-cloud-init
```

Add one of the examples below to the end of the file. The network interface number needs to be unique, set it to one larger than the previous one. If you haven't added addresses before it should be eth3 like in the example here.

```
auto eth3
iface eth3 inet dhcp
```

In the case of IPv6 the syntax is a little different, use the following instead.

```
auto eth3
iface eth3 inet6 auto
```

Then save the file and exit the editor.

Next, prevent cloud-init from overwriting your changes by creating a disable file.

```
sudo nano /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
```

Add the following line to the file.

```
network: {config: disabled}
```

Save the file and exit the editor.

Restart the network to apply the changes.

```
sudo systemctl restart networking
```

Check that the new interface appears and shows the correct new IP address with the following command.

```
ip addr
```

```
5: eth3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 6e:d7:1b:bf:63:c8 brd ff:ff:ff:ff:ff:ff
    inet 185.26.50.223/22 brd 185.26.51.255 scope global eth3
       valid_lft forever preferred_lft forever
    inet6 fe80::6cd7:1bff:febf:63c8/64 scope link
       valid_lft forever preferred_lft forever
```

Once you see the new interface at the end of the list like in the example above you've successfully configured a new IP address to your Cloud Server. It can now be used to connect to the host just like the other addresses.

If you have problems reaching one of the IP addresses with ping, for example, try rebooting the server and testing the connection again.

```
sudo reboot
```

Also, make sure your firewall settings allow connecting to the new IP address as well.

### Debian 11 and Ubuntu 20 or earlier

Connect to your Cloud Server. Once in, you’ll need to add a new interface configuration to the /etc/network/interfaces file. Open it for editing with elevated privileges.

```
sudo nano /etc/network/interfaces
```

Then enter one of the examples underneath the end of the file. The number of the network interface needs to be unique, set it to one larger than the previous one. If you haven’t added addresses before it should be eth3 like in the example here.

```
auto eth3
iface eth3 inet dhcp
```

In the case of IPv6 the syntax is a little different, use the following instead.

```
auto eth3
iface eth3 inet6 auto
```

Then save the file and exit the editor.

Afterwards, you’ll need to restart the network to have the changes take effect.

```
sudo systemctl restart networking
```

Check that the new interface appears and shows the correct new IP address with the following command.

```
ip addr
```

If the IP addresses are not working after this, add the following lines to /etc/sysctl.conf:

```
sudo nano /etc/sysctl.conf
```

```
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
net.ipv4.ip_forward = 1
```

On Ubuntu, you might also need to add the following to the specific new network interface and replace the number on the lines as appropriate.

```
net.ipv4.conf.eth3.rp_filter = 2
net.ipv4.conf.eth3.arp_filter = 1
```

Once you’ve saved the sysctl.conf, update the system status.

```
sudo sysctl -p
```

Then restart the network using the same command as above and check the IP addresses again.

```
sudo systemctl restart networking
```

```
ip addr
```

```
5: eth3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 6e:d7:1b:bf:63:c8 brd ff:ff:ff:ff:ff:ff
    inet 185.26.50.223/22 brd 185.26.51.255 scope global eth3
       valid_lft forever preferred_lft forever
    inet6 fe80::6cd7:1bff:febf:63c8/64 scope link
       valid_lft forever preferred_lft forever
```

Once you see the new interface at the end of the list like in the example above you’ve successfully configured a new IP address to your Cloud Server. It can now be used to connect to the host just like the other addresses.

If you have problems reaching one of the IP addresses with ping, for example, try rebooting the server and testing the connection again.

```
sudo reboot
```

Also, make sure your firewall settings allow connecting to the new IP address as well.

### CentOS

You’ll need to create a new network interface configuration file in the /etc/sysconfig/network-scripts folder. Copy one of the pre-existing files to have a starting point, for example, the ifcfg-eth0 to ifcfg-eth3 with the following command.

```
sudo cp /etc/sysconfig/network-scripts/ifcfg-eth0 /etc/sysconfig/network-scripts/ifcfg-eth3
```

Then open the new file and change it to suit the new interface. Replace the device number on the first line with a new higher number. Commonly it would be eth3 like in the example below if this is the first address you are adding after deploying the cloud server.

```
DEVICE=eth3
BOOTPROTO=dhcp
ONBOOT=yes
```

If you are attaching an IPv6 address, you can copy the existing IPv6 configuration.

```
sudo cp /etc/sysconfig/network-scripts/ifcfg-eth2 /etc/sysconfig/network-scripts/ifcfg-eth3
```

Then change the device name, for example as below.

```
DEVICE=eth3
NM_CONTROLLED=no
IPV6INIT=yes
```

Check your /etc/sysctl.conf, and make sure the default rp\_filter is set to 0.

```
sudo sysctl -a | grep default.rp_filter
```

If not, open the file to edit and add the parameter to the end of the file.

```
net.ipv4.conf.default.rp_filter = 0
```

If you made changes to the sysctl.conf, update the system.

```
sudo sysctl -p
```

Use the following command after you have done these operations to restart the network.

```
sudo systemctl restart network
```

Then check the IP configuration.

```
ip addr
```

```
5: eth3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP qlen 1000
    link/ether 6e:d7:1b:bf:49:64 brd ff:ff:ff:ff:ff:ff
    inet 185.20.138.90/22 brd 185.20.139.255 scope global dynamic eth3
       valid_lft 86189sec preferred_lft 86189sec
    inet6 fe80::6cd7:1bff:febf:4964/64 scope link
       valid_lft forever preferred_lft forever
```

When you see the new IP address in the command output it’s connected and ready to use.

If you have problems reaching one of the IP addresses with ping, for example, try rebooting the server and testing the connection again.

```
sudo reboot
```

Also, make sure your firewall settings allow connecting to the new IP address as well.

### Windows

New network interfaces for IPv4 addresses should show up automatically without manual configuration.

In the case of IPv6, you will need to run a couple of commands via Command Prompt with Administrator privilege. Open the program by typing `cmd` in the Run window and press enter, then copy in the commands below.

```
netsh interface ipv6 set global randomizeidentifiers=disabled store=active
netsh interface ipv6 set global randomizeidentifiers=disabled store=persistent
netsh interface ipv6 set privacy state=disabled store=active
netsh interface ipv6 set privacy state=disabled store=persistent
```

Afterwards, you should restart the new network interface by disabling and re-enabling it at the Network Connections window.

Note that the Windows Server firewall blocks ICMP requests by default. If you want to test the new interface with ping, open the firewall settings with wf.msc in the run window. Find the ICMPv4 and ICMPv6 protocols in the Inbound Rules and enable the ones you need.

### Other options

It’s also possible to manually set additional public IPv4 addresses to the primary interface, for example creating aliases like eth0:1, and eth0:2 on Linux, by using static configuration. Currently, this is not supported with IPv6 addresses. You can find instructions for setting up alias addresses in our articles for configuring floating IPs on [CentOS](/docs/guides/configure-floating-ip-centos.md), [Debian](/docs/guides/configure-floating-ip-debian.md), [Ubuntu](/docs/guides/configure-floating-ip-ubuntu.md) or [Windows](/docs/guides/configure-floating-ip-windows.md).
