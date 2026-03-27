# Firewall

We offer an optional Layer 3 firewall that is positioned just before the network interface connecting the Cloud Servers to the Internet. The firewall rules can be applied to the Public and Utility network traffic, SDN private networks are excluded.

The firewall is stateless and does not keep track of connections. Users are required to configure rules to allow both incoming and outgoing traffic.

## SMTP block

The outbound SMTP port 25 is closed by default on all new accounts to prevent accidental open relays and misuse. The blocked port shows up on the UpCloud firewall of the Cloud Server at the user’s control panel and cannot be changed directly.

Users can request the port to be unlocked by contacting our support team.

Users will be required to provide proof of identity or payment method for verification and explain the use case and why the outbound port 25 is needed. This is done to ensure the responsible use of SMTP and build trust in our network for email delivery.

## Trial Limitations

During the free trial, inbound and outbound connections are limited to standard ports commonly used on web servers. These limitations are removed when the user upgrades to full access.

Accepted connections:

| Inbound port number | Outbound port number |
| --- | --- |
| 22 | 53 |
| 80 | 80 |
| 443 | 443 |
| 3389 | 8080 |
| 123 | 123 |
| 33434 - 33534 | 33434 - 33534 |
