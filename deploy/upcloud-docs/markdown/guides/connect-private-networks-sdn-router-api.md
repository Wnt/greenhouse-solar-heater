# How to connect private networks using SDN Router API

Using SDN Private Networks, you have a lot of freedom to configure secure connectivity between your cloud servers. With the introduction of SDN Router API, you can create a gateway between any number of SDN Private Networks within a data centre.

SDN Routers are expanding the customisation possibilities of SDN Private Networking.

If you are not yet familiar with the UpCloud API, we would suggest taking a quick look at our guide to [getting started with UpCloud API](/docs/guides/getting-started-upcloud-api.md) to set up your API user account and access rights.

## Creating a new SDN router

SDN Router API makes it very simple to connect existing SDN Private Networks without added complexity or new IP addresses to configure. Getting started managing SDN Routers via the [UpCloud API](https://developers.upcloud.com/1.3/13-networks/) is quick and easy.

You can get the list of all currently available routers using the following request. By default, you’ll only see the Utility Router connecting your cloud servers across your whole account.

```
GET /1.3/router/
```

You will get a response with just the default router for the Utility network.

```
{
   "routers": {
      "router": [
         {
            "attached_networks": {
               "network": [
                  {
                     "uuid": "039fe709-053a-4790-9290-572e2c32ba0e"
                  }
               ]
            },
            "name": "Utility network router for zone fi-hel1",
            "type": "service",
            "uuid": "04104678-d957-4c4d-9775-46621f2841e1"
         }
      ]
   }
}
```

Deploy a new router by sending a request that includes the following body formatted in JSON to name your router.

```
POST /1.3/router/
```

```
{
   "router": {
      "name": "My Router"
   }
}
```

If successful, you’ll get a response similar to the example below.

```
{
   "router": {
      "attached_networks": {
         "network": []
      },
      "name": "My Router",
      "type": "normal",
      "uuid": "04f42ad3-309e-43fc-8576-68869fdf5678"
   }
}
```

Your new router will then appear on the list of available routers if you query it again.

## Attaching network

Once you’ve created your first SDN Router, you can begin attaching SDN Private Networks. If you haven’t yet got started with SDN Private Networks, check out our guide on [how to configure SDN Private Networks using the UpCloud API](/docs/guides/configure-sdn-private-networks-upcloud-api.md).

In practice, attaching private networks to a router works by setting the router parameter in the network details to match the UUID of the router you wish to connect to. Each network can only be attached to one router at a time.

Check the UUID of your SDN Router in response to creating it, then set the router UUID in the details of your SDN Private Network. Replace the UUIDs in the following request and body message accordingly.

```
PUT /1.3/network/{network-uuid}
```

```
{
   "network": {
      "router": "{router-uuid}"
   }
}
```

If your network was successfully attached to the router, you’ll see a response similar to the example below.

```
{
   "network": {
      "ip_networks": {
         "ip_network": [
            {
               "address": "11.0.0.0/24",
               "dhcp": "yes",
               "dhcp_default_route": "no",
               "family": "IPv4",
               "gateway": "11.0.0.1"
            }
         ]
      },
      "name": "Private network 1",
      "router": "04f42ad3-309e-43fc-8576-68869fdf5678",
      "type": "private",
      "uuid": "035661db-570c-4c46-9903-6dc890f56343",
      "zone": "fi-hel1"
   }
}
```

You can find the UUIDs of your SDN Private Networks using the following request.

```
GET /1.3/network/
```

```
{
   "networks": {
      "network": [
         ...
         {
            "ip_networks": {
               "ip_network": [...]
            },
            "name": "Private network 1",
            "servers": {
               "server": [...]
            },
            "type": "private",
            "uuid": "035661db-570c-4c46-9903-6dc890f56343",
            "zone": "fi-hel1"
         },
         {
            "ip_networks": {
               "ip_network": [...]
            },
            "name": "Private network 2",
            "servers": {
               "server": [...]
            },
            "type": "private",
            "uuid": "03beb27f-73a5-4333-93fd-7052b7b0791b",
            "zone": "fi-hel1"
         }
      ]
   }
}
```

Once your private networks are connected via the router, you still need to create new routes to enable communication between the private networks. To accomplish this log into the cloud servers and add the relevant routes between the networks to their corresponding network interfaces.

For example, to add a route between SDN Priavet Networks with the IP ranges of 11.0.0.0/24 and 12.0.0.0/24, you’ll need to add the following rule on cloud servers connected to 11.0.0.0/24 with the gateway 11.0.0.1. Replace the IP addresses and the network interface eth3 in the example with your network details.

```
ip route add 12.0.0.0/24 via 11.0.0.1 dev eth3
```

Afterwards, if you check the configured routes with the next command, you should see the new route connecting to the other private network.

```
ip route
```

```
...
11.0.0.0/24 dev eth3 proto kernel scope link src 11.0.0.2 metric 102
12.0.0.0/24 via 11.0.0.1 dev eth3 proto dhcp metric 102
```

Repeat these steps on each cloud server you want to use between the private networks.

That’s it! Your cloud servers connected to either private network can now communicate via the router gateway.

## Detaching networks

When you no longer need to connect a specific SDN Private Network, you can detach it from your router at any point.

To detach a network from a router, set the router in your network details to empty.

```
PUT /1.3/network/{network-uuid}
```

```
{
   "network": {
      "router": ""
    }
}
```

You will then get a response to confirm your private network has been detached. Note that the router parameter is no longer present.

```
{
   "network": {
      "ip_networks": {
         "ip_network": [
            {
               "address": "11.0.0.0/24",
               "dhcp": "yes",
               "dhcp_default_route": "no",
               "family": "IPv4",
               "gateway": "11.0.0.1"
            }
         ]
      },
      "name": "Private network 1",
      "type": "private",
      "uuid": "035661db-570c-4c46-9903-6dc890f56343",
      "zone": "fi-hel1"
   }
}
```

The selected network will then have been detached from your router.
