# How to configure SDN Private networks using the UpCloud API

[SDN](https://upcloud.com/products/software-defined-networking/) Private networks offer unmetered secure networking customisable by you. Create isolated environments within zones or allow traffic through a cloud server acting as a firewall and router. Define custom local networks with the IP ranges of your choosing and attach IPs statically or automatically using DHCP.

The new private networks allow you to connect an unlimited number of cloud servers to any private network for no additional cost. The predictable prices remain the same regardless of the number of connected cloud servers or the amount of transferred traffic. SDN Private networks are quick and easy to configure using the UpCloud API.

If you are not yet familiar with the UpCloud API, we would suggest taking a quick look at our guide to [getting started with UpCloud API](/docs/guides/getting-started-upcloud-api.md) to set up your API user account and access rights.

## Getting information on existing networks

Your cloud servers can be connected to three different types of networks: public, utility, and private. Public networks provide access to the internet while the Utility network securely interconnects all of the cloud servers on your UpCloud account. Both of these are configured automatically. The last of the three, the SDN private networks, allows you to create custom software-defined networks which can be used for just about anything you might want.

You can get a list of all current networks using the API command below.

```
GET /1.3/network
```

The full list of networks will include all public, utility, and private networks in all zones. The following is an example response showing just the first network block. The rest of the output is truncated for brevity.

```
{
   "networks": {
      "network": [
         {
            "ip_networks": {
               "ip_network": [
                  {
                     "address": "80.69.172.0/22",
                     "dhcp": "yes",
                     "dhcp_default_route": "yes",
                     "dhcp_dns": [
                        "94.237.127.9",
                        "94.237.40.9"
                     ],
                     "family": "IPv4",
                     "gateway": "80.69.172.1"
                  }
               ]
            },
            "name": "Public 80.69.172.0/22",
            "type": "public",
            "uuid": "03000000-0000-4000-8001-000000000000",
            "zone": "fi-hel1"
         },
...
```

Optionally, you can list only the networks in a specific zone. This can be useful as SDN private networks are configured per data centre. Replace the {zone} in the API call with the data centre ID you wish to view, for example, fi-hel2 or uk-lon1.

```
GET /1.3/network/?zone={zone}
```

The response will be much like with the whole list, just filtered based on the selected zone. The output is again truncated.

```
{
   "networks": {
      "network": [
         {
            "ip_networks": {
               "ip_network": [
                  {
                     "address": "83.136.248.0/22",
                     "dhcp": "yes",
                     "dhcp_default_route": "yes",
                     "dhcp_dns": [
                        "94.237.127.9",
                        "94.237.40.9"
                     ],
                     "family": "IPv4",
                     "gateway": "83.136.248.1"
                  }
               ]
            },
            "name": "Public 83.136.248.0/22",
            "servers": {
               "server": [
                  {
                     "title": "example.upcloud.com",
                     "uuid": "0033d352-035c-4fc1-b37d-932ee5a437fc"
                  }
               ]
            },
            "type": "public",
            "uuid": "03000000-0000-4000-8008-000000000000",
            "zone": "uk-lon1"
         },
...
```

From the list of currently available networks, you can find the UUID of the network you wish to use. Get detailed information about a specific network with the API request below. Replace the {network\_uuid} with the network UUID you want.

```
GET /1.3/network/{network_uuid}
```

Underneath is an example of an SDN private network details with one connected server.

```
{
   "network": {
      "ip_networks": {
         "ip_network": [
            {
               "address": "10.0.0.0/24",
               "dhcp": "yes",
               "dhcp_default_route": "no",
               "family": "IPv4",
               "gateway": "10.0.0.1"
            }
         ]
      },
      "name": "My Network",
      "servers": {
         "server": [
            {
               "title": "example.upcloud.com",
               "uuid": "0033d352-035c-4fc1-b37d-932ee5a437fc"
            }
         ]
      },
      "type": "private",
      "uuid": "033e8c5b-a05a-4b61-b424-35b28b13e8ea",
      "zone": "uk-lon1"
   }
}
```

## Creating new SDN private networks

To be able to make custom connections between your cloud server, you first need to create a private network. This can be done using the command below while defining the network settings in the API request body.

```
POST /1.3/network
```

```
{
   "network": {
      "name": "My Network 2",
      "zone": "uk-lon1",
      "ip_networks" : {
         "ip_network" : [
            {
               "address" : "10.0.0.0/24",
               "dhcp" : "yes",
               "family" : "IPv4"
            }
         ]
      }
   }
}
```

The information in this example only includes the required fields, you have a couple of additional attributes which are outlined in our [API documentation](https://developers.upcloud.com/1.3/13-networks/#create-sdn-private-network).

If the request was executed successfully, you’ll get a response such as in the example below.

```
{
   "network": {
      "ip_networks": {
         "ip_network": [
            {
               "address": "10.0.0.0/24",
               "dhcp": "yes",
               "dhcp_default_route": "no",
               "family": "IPv4",
               "gateway": "10.0.0.1"
            }
         ]
      },
      "name": "My Network 2",
      "type": "private",
      "uuid": "03cd6945-1dd4-4ad7-81aa-f7cf936d026d",
      "zone": "uk-lon1"
   }
}
```

Once created, you’ll be able to see the new network with the API commands to list networks or directly by using the UUID.

The SDN private networks can also be later modified to update the information, for example, if you wish to disable DHCP. Replace the {network\_uuid} with the network UUID you wish to modify.

```
PUT /1.3/network/{network_uuid}
```

```
{
   "network": {
      "name": "My Network 2",
         "ip_networks": {
            "ip_network": [
               {
                  "dhcp": "no",
                  "family" : "IPv4"
               }
            ]
         }
      }
   }
}
```

The response will then confirm the changes.

## Attaching servers to networks

Once you’ve created a new SDN private network, you can connect cloud servers to it by attaching a new network interface to the desired server.

The server state must be stopped while a new network interface is being added. You can shut down a cloud server with the following command.

```
POST /1.3/server/{server_uuid}/stop
```

Then create a new network interface using the API request and body as shown below. Replace the {server\_uuid} and {network\_uuid} with the specific cloud server and SDN private network identifiers you wish. At the same time, you can also manually set the IP address for the interface or leave out the address if your network is configured to use DHCP. Additionally, enable or disable the source\_ip\_filtering depending on whether you wish to only allow traffic from other servers within the same network.

```
POST /1.3/server/{server_uuid}/networking/interface
```

```
{
   "interface": {
      "type": "private",
      "network": "{network_uuid}",
      "ip_addresses": {
         "ip_address": [
            {
               "family": "IPv4",
               "address": "10.0.0.10"
            }
         ]
      },
      "source_ip_filtering": "yes"
   }
}
```

If the new network interface was created successfully, you’ll get a response similar to the example below.

```
{
   "interface": {
      "index": 4,
      "ip_addresses": {
         "ip_address": [
            {
               "address": "10.0.0.10",
               "family": "IPv4",
               "floating": "no"
            }
         ]
      },
      "mac": "6e:d7:1b:bf:d9:00",
      "network": "03cd6945-1dd4-4ad7-81aa-f7cf936d026f",
      "source_ip_filtering": "yes",
      "type": "private"
   }
}
```

Afterwards, you can restart the cloud server again.

```
POST /1.3/server/{server_uuid}/start
```

Attaching or modifying network interfaces only performs actions on the infrastructure side, you will also need to configure any new interfaces on the operating system level. Follow our guide for [attaching new IP addresses](/docs/guides/attaching-new-ip-addresses.md) according to your OS.

The network interfaces can also be modified later on if you wish to e.g. change the IP address or even move the cloud server to a different SDN private network entirely. Replace the {server\_uuid} with your cloud server identifier and the {index} with the network interface number you wish to modify.

Note that, again, the server must be in the stopped state.

```
PUT /1.3/server/{server_uuid}/networking/interface/{index}
```

```
{
   "interface": {
      "type": "private",
      "network": "0374ce47-4303-4490-987d-32dc96cfd79b",
      "ip_addresses": {
         "ip_address": [
            {
               "family": "IPv4",
               "address": "10.0.0.10"
            }
         ]
      }
   }
}
```

The response will then return a confirmation of the changes.

## Detaching servers from networks

When you wish to detach a cloud server from any specific SDN private network, it is as simple as deleting the associated network interface. This can be done using the following command. Select the server and network interface you wish to remove by replacing the {server\_uuid} and {index} as needed.

```
DELETE /1.3/server/{server_uuid}/networking/interface/{index}
```

Note that the server state must again be stopped while modifying the network interfaces.
