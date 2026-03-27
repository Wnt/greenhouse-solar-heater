# Example VPN Gateway setups

## Single VPN tunnel

In this example setup, an IPsec site-to-site VPN tunnel connects servers in an [SDN Private Network](/docs/products/networking/sdn-private-networks.md) to a remote network.

![Single tunnel setup](vpn-single-tunnel.png "Example of a single VPN tunnel setup")

Example of a single VPN tunnel setup

## VPN tunnels to multiple locations

VPN Gateways support multiple tunnels to different locations. Since local routes must be unique, each VPN tunnel requires a separate SDN Private Network. Servers can join one or multiple of these SDN Private Networks, based on their access requirements.

![Multi-network setup](vpn-multiple-networks.png "Example of connecting multiple SDN Private Networks with multiple remote networks")

Example of connecting multiple SDN Private Networks with multiple remote networks

## Gateway with NAT and VPN

A single gateway instance can act both as a NAT and VPN gateway, combining remote network connectivity and Internet access.

![Combined NAT & VPN gateway](combined-vpn-nat.png "Example of a combined NAT & VPN gateway setup")

Example of a combined NAT & VPN gateway setup
