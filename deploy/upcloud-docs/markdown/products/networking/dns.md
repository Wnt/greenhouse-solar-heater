# DNS

UpCloud network includes a [Domain Name Service resolver](/docs/guides/dns-servers.md) at each location that can be reached at the following IP addresses.

The UpCloud DNS resolver IPv4 addresses are:

- 94.237.127.9
- 94.237.40.9

Cloud servers with a public IPv6 address can also use IPv6 with the following servers:

- 2a04:3540:53::1
- 2a04:3544:53::1

We do not currently offer a user-configurable authoritative DNS service for hosting your domain names.

## Reverse DNS

UpCloud users can set a Reverse DNS, or PTR, record on each of their IP addresses. Querying an rDNS is a Domain Name System (DNS) technique to determine the hostname associated with an IP address.

Each IP address on UpCloud has a default rDNS set upon creation which can be changed at the UpCloud Control Panel or via the UpCloud API free of charge.
