# Floating IP

Floating IPs are special IPv4 addresses that can be transferred from one Cloud Server to another at a moment’s notice without the need to restart the servers. They are useful for failover services on mission-critical functions to ensure high availability.

The Floating IP can be transferred between any cloud Servers within the same data centre but requires prior configuration at the operating system level which needs to be done manually by the user.

The failover between servers can be done manually at the [UpCloud Control Panel](https://hub.upcloud.com) or automated using [API commands](https://developers.upcloud.com/1.3/10-ip-addresses).

Floating IPs are only available using IPv4 in the public network. Floating IPs cannot be configured using IPv6 or in the Utility or SDN private networks.
