# Routing using the NAT Gateway

Routing affects where network traffic is sent from a server. It affects how the server reaches other servers on local networks and how it accesses remote networks (i.e. the public internet) through a gateway.

The default route is where all traffic is sent to which does not have a more specific route configuration. In a typical network setup, each server has a single gateway which can be used to access the internet.

## Using DHCP

It is highly recommended to use DHCP for network and route configuration. DHCP is used to automatically distribute IP addresses to servers on the SDN Private Network. It is also used to configure the gateway address. For fully automatic network interface configuration, make sure to enable

- DHCP on the server network interfaces (on by default in all UpCloud operating system templates)
- Enable DHCP on the SDN Private Network
- Enable DHCP and add default route by DHCP on the SDN Router

## Potential pitfalls

A server connected to an SDN Private Network with an attached NAT Gateway does not need its own public IP address, and it is recommended to remove it completely to avoid networking problems. NAT Gateways and the public network interface both provide a default gateway, and creates a situation where the server has multiple default gateways.
