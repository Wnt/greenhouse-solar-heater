# Configuring your firewall for DNS server queries

A common problem with server networking is that DNS (Domain Name Service) queries get blocked by a firewall. This may result in long connection establishment times with services, such as inbound SSH, resolving reverse hostnames. It can also prevent establishing outbound connections using DNS names instead of IP addresses, like with operating system updates.

The [UpCloud firewall](/docs/guides/managing-firewall.md) service can be configured by using either the [UpCloud Control Panel](https://hub.upcloud.com/) or the [API](https://developers.upcloud.com/1.3/). Many users also choose to run their own firewalls inside their servers, such as *iptables* on Linux. In both cases, the DNS queries must be explicitly allowed by the firewall to have name-resolving work.

All DNS resolvers at UpCloud have the same IP addresses regardless of the availability zone. This makes it easy to copy firewall rules from one server to another or templatize firewall rules. The DNS servers are provided automatically by the DHCP protocol, and there should be no need for manual configurations in the operating system, except for the DNS firewall rules.

The UpCloud DNS resolver IPv4 addresses are:

- **94.237.127.9**
- **94.237.40.9**

If your server has a public IPv6 address, you can also use IPv6 with the following servers:

- **2a04:3540:53::1**
- **2a04:3544:53::1**

The basic firewall rule for allowing DNS queries is to permit inbound **UDP and TCP** traffic **from port 53** **to any port** from the DNS IP addresses. While the DNS server has traditionally worked only with UDP there are several recent additions like DNSSEC and SPF which might also require TCP connections to be allowed – otherwise, some of the queries might not go through.

You can create all required DNS firewall rules with one click by enabling the *Auto-add DNS rules* at your server firewall settings and then clicking the *Save changes* button.

![Auto add DNS rules](img/image.png)

### Running your own DNS servers

It is also possible to use your cloud servers to provide your own DNS, which could be used as the authoritative name server for your domain. For best redundancy, it is strongly recommended that you have at least two different authoritative name servers in different locations. For example, one in our Amsterdam zone and another in Chicago.

There are several DNS server software [available](https://en.wikipedia.org/wiki/Comparison_of_DNS_server_software#Feature_matrix) with the most common open source variants used with Linux being [BIND](https://www.isc.org/downloads/bind/), [PowerDNS](https://www.powerdns.com/) and [djbdns](https://cr.yp.to/djbdns.md). The exact configuration for each of them is outside of the scope of this article, but you can find many excellent guides on the Internet, starting with the documentation for the specific DNS software.

If you choose to set up your own name server, it is paramount to make sure that the server is not a so-called **open resolver**. These are frequently scanned and exploited by DDoS attacks against third-party targets. The key rule is to **only** serve replies to queries regarding your own domains, which the DNS is authoritative for. Recursion should only be allowed from localhost.

Running your own nameserver will require additional firewall settings, as you must also enable inbound DNS queries. In other words, allow **UDP and TCP** protocol **from any address to port 53** in your firewall rules.
