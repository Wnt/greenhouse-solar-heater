# SDN Private Networks

Software-defined networking, or SDN for short, is a technological approach to network management that enables dynamic, programmatically created network configurations. SDN decouples the network configuration from the physical infrastructure much like cloud computing has done for traditional server hosting.

Using SDN private networks, users are able to create and configure custom private networks on demand.

SDN private networks are created within a specific data centre and allow connecting an unlimited number of cloud servers within that data centre.

## SDN features

SDN Private Networks support the following features:

- **Gateway IP:** Setting a custom gateway IP address for your SDN Private Network. This allows for more advanced network configurations and integration with existing infrastructure.
- **DHCP Control:** Enable or disable the DHCP service on your SDN Private Network. This gives you finer control over IP address assignment for your connected Cloud Servers.
- **Default route via DHCP:** Configure whether the default route (0.0.0.0/0) is automatically set via DHCP for Cloud Servers connected to the SDN Private Network. This simplifies network setup and ensures proper routing. Note that this setting should be disabled if a preferred route to the Internet is through a local IP address on the server.
- **Auto-populating routes:** SDN Private Networks automatically learn and populate available routes through DHCP. This makes it easier to manage complex network topologies and ensures efficient routing. Routes are automatically learnt from connected services such as Managed Databases, Object Storage, NAT Gateways and VPN Gateways.
- **Static routes:** Define static routes within your SDN Private Network to direct traffic to specific destinations. This allows for more granular control over network traffic flow.

![](sdn-network-settings.png)

## Available IP subnets

Generally, users can utilise any global unicast address for their subnet address, even public ones. However, we recommend staying with well-known private address ranges.

### Recommended address ranges

- 10.0.0.0/8
- 172.16.0.0/12
- 192.168.0.0/16

Allowed subnet prefix lengths (sizes): minimum length 8 bits, maximum length 29 bits.

### Excluded ranges

- 100.64.0.0/10 (CGNAT)
- 127.0.0.0/8 (localhost)
- 224.0.0.0/4 (IP multicast)
- 169.254.0.0/16 (link-local)

The above ranges are not available for use in SDN private networks.

## Network speed

SDN private network interfaces provide up to 10 Gbit/s link speeds. The network throughput between Cloud Servers may vary.
