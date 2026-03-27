# Static routing and VPN connections

Static routing is an easy and predictable way to configure routing between networks connected using a VPN tunnel. VPN Gateways supports only static routing. Dynamic or policy based routing is not supported.

With static routing, VPN Gateways are configured to route only specific IP subnets. This involves configuring the VPN Gateways at both ends of the VPN tunnel.

IP subnets should be chosen in a way that they don't collide on either side on the VPN tunnel.

![Example of route configuration](vpn-routes.png)

Example of route configuration
