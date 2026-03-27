# How to connect private networks using SDN Router

Using SDN Private Networks, you have a lot of freedom to configure secure connectivity between your cloud servers. With the introduction of SDN Routers, you can create a gateway between any number of SDN Private Networks within a data centre.

SDN Routers are expanding the customisation possibilities of SDN Private Networking.

## Deploy new SDN Router

SDN Routers make it very simple to connect existing SDN Private Networks without added complexity or new IP addresses to configure.

Get started by deploying an SDN Router at your [UpCloud Control Panel.](https://hub.upcloud.com/networks/routers)

Go to the Routers section in the Network menu to find the view of your current SDN Routers. By default, you’ll only see the Utility Router connecting your cloud servers across your whole account.

Click the *Create SDN Router* button to begin.

![SDN Router list](img/image.png)

Then name your new router and click the *Create SDN Router* button to confirm.

![Creating new SDN Router](img/image-1.png)

Your new router will then appear on the list.

## Attaching networks

Once you’ve created your first [SDN Router](https://hub.upcloud.com/networks/routers), you can begin attaching SDN Private Networks. If you haven’t yet configured any SDN Private Networks, check out our [guide on how to get started](/docs/guides/configure-sdn-private-networks.md).

Click on the SDN Router you wish to use to connect your private networks.

![New SDN Router](img/image-2.png)

In the SDN Router view, you can see a couple of details about your router, rename the router as well as attach and detach private networks.

Start connecting networks by clicking the Attach SDN Private Network button.

![SDN Router details](img/image-3.png)

Then in the following view, select the data centre you want to configure and pick the SDN Private Network from the list. You can also choose whether the router will provide DHCP routes to private networks. If disabled, you will need to configure the routes manually.

Once all set, click the *Attach network* button to confirm.

![Attaching private network to SDN Router](img/image-4.png)

Repeat the same to attach any networks you wish to connect together.

The attached SDN Private Networks then appear on the list along with the relevant network information.

![Private networks attached to SDN Router](img/image-5.png)

Once your private networks are connected via the router, you still need to enable the new route to enable communication between the private networks.

This can be done by logging into the attached cloud servers and running the following commands. Replace the eth3 in the commands with the network interface of your SDN Private Network.

```
dhclient -r eth3
dhclient eth3
```

Afterwards, if you run the command below, you should see a new route connecting to the other private network.

```
ip route
```

```
...
11.0.0.0/24 via 12.0.0.1 dev eth3
12.0.0.0/24 dev eth3 proto kernel scope link src 12.0.0.2
```

Repeat these commands on each cloud server you want to use between the private networks.

That’s it! Your cloud servers connected to either private network can now communicate via the router gateway.

## Detaching networks

When you no longer need to connect a specific SDN Private Network, you can detach it from your router at any point.

To detach a network, go to the SDN Routers list in your UpCloud Control Panel and select your SDN Router.

Click the *Detach* button on the SDN Private Network you wish to disconnect from the router.

![Detach network from SDN Router](img/image-6.png)

Then click the *Detach* button in the following window to confirm.

![Confirm detaching network from SDN Router](img/image-7.png)

The selected network will then have been detached from your router.
