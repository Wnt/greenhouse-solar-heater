# How to configure SDN Private networks

Private networks [enabled by SDN](https://upcloud.com/products/software-defined-networking/) offer unrestricted secure networking customisable by you. Create isolated environments within zones or allow traffic through a cloud server acting as a firewall and router. Define custom local networks with the IP ranges of your choosing and attach IPs statically or automatically using DHCP.

## Network control panel

At your UpCloud Control Panel, go to the Private Network section under the Network menu where you can find the private networks currently configured on your account.

![Private networks](img/image.png)

Any new Private networks you create will appear on this list. Initially, you’ll only see the default Utility network that securely interconnects all of the cloud servers on your UpCloud account.

Here is also where you can see the cloud servers attached to your private networks by clicking on any particular network to expand the view.

## Creating new private networks

Creating and configuring new private networks is really simple. Open your UpCloud Control Panel and the [Private Network](https://hub.upcloud.com/networks/private) section under the Network menu.

Click the *Create SDN network* button to begin configuring a new one.

![Create SDN Network button](img/image-1.png)

Configure a new private network by naming the network as you like and choosing the location you want the network to be deployed at. Only servers within the same location can be directly attached to a private network at that data centre.

![Create SDN Network](img/image-2.png)

Afterwards, click the *Create SDN network* button to confirm.

![Network successfully created](img/image-3.png)

All set, your new private network is then ready for attaching cloud servers. Check the instructions below on how to join servers to the network.

## Attaching servers to networks

Go to your [UpCloud Control Panel](https://hub.upcloud.com/) and open Network options in the settings of the server you wish to attach to a new private network.

![Server networks](img/image-4.png)

By default, every UpCloud server has two public IP addresses, versions 4 and 6, as well as a single private IP address connected to the utility network.

Start by clicking the *Attach SDN private network* button.

![Attach SDN private network](img/image-5.png)

This opens a new window that lists the available private networks at your server’s location.

Choose the private network you want to attach to your cloud server.

![Attach SDN private network to your server](img/image-6.png)

Alternatively, you can create a new private network by selecting the *Create new SDN network* option and configuring the new network with a name and a location.

You can also select whether you wish the private network to assign an IP address for your server automatically using DHCP, or manually allowing you to enter the IP you wish within the network.

Once you’ve made the selections, click the *Attach network* button to confirm.

![Network selected](img/image-7.png)

That’s it, your cloud server has now been attached to the private network. It will show as a new network interface and display the IP address you chose to use.

![Network attached](img/image-8.png)

However, before you are quite finished, you still need to configure a new network interface at your operating system level. Check the guide on [how to add new IP addresses](/docs/guides/attaching-new-ip-addresses.md) for instructions on this.

## Removing servers from networks

Detaching servers from a network is as simple as deleting the network interface used to join the server to the private network.

Go to your [UpCloud Control Panel](https://hub.upcloud.com/) and the Network menu under your server settings.

Click the delete icon on the network interface you wish to remove.

![Detach private network](img/image-9.png)

Then complete the removal by clicking the *Detach* button in the confirmation window.

![Detach network interface](img/image-10.png)

The cloud server has then been detached from that particular private network. If you are not expecting to use the same interface again, you may delete the IP address at your OS level, or leave the configuration in place if you want to attach the cloud server to another private network.

The same method can be used to detach cloud servers from the utility network by deleting the default private IP address if you so choose.
