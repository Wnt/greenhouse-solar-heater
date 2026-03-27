# Advanced Features for SDN Private Networks

March 5, 2025
·
[Permalink](/docs/changelog/2025-03-05-advanced-sdn-features.md)

New configuration options are available for SDN Private Networks, giving you more control and flexibility over your network setup:

- **Gateway IP:** You can now specify a custom gateway IP address for your SDN Private Network. This allows for more advanced network configurations and integration with existing infrastructure.
- **DHCP Control:** Enable or disable DHCP on your SDN Private Network. This gives you finer control over IP address assignment for your connected Cloud Servers.
- **Default route via DHCP:** Configure whether the default route (0.0.0.0/0) is automatically set via DHCP for Cloud Servers connected to the SDN Private Network. This simplifies network setup and ensures proper routing.
- **Auto-populating routes:** SDN Private Networks now automatically learn and populate available routes through DHCP. This makes it easier to manage complex network topologies and ensures efficient routing.
- **Static routes:** Define static routes within your SDN Private Network to direct traffic to specific destinations. This allows for more granular control over network traffic flow.

![](sdn-network-settings.png)

These new settings provide greater flexibility and control over your SDN Private Networks, making it easier to manage complex network configurations and optimize your cloud infrastructure.
