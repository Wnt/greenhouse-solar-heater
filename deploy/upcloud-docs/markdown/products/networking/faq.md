# Networking FAQ

## Network configuration

**Do you support multiple IP addresses per server?**

Yes. Each server can have up to 5 public IPv4 addresses, 5 IPv6 addresses, and 1 private IPv4 address. Find out more in our guide for [attaching new IP addresses](/docs/guides/attaching-new-ip-addresses.md).

**Do you offer IPV6 support?**

Yes. Every cloud server gets a free IPv6 address unless you wish to disable it at deployment.

**Can I bring my own IPs or IP range?**

Yes, you can do this in our Private Cloud. Contact our [sales team](https://upcloud.com/contact/) for more information.

**Do you offer private networking?**

Yes. Our SDN private networks and the account-wide utility network allow your servers to communicate securely. Only servers on your account can communicate via the utility network connection while with SDN private networks you get even more control over which cloud servers are connected. Your private networks are exclusively yours.

## Connectivity

**How can I test your network speed?**

You can do a network speed test by manually copying files between servers. Alternatively, you can test the network latency using ping. Please note that the network speed is restricted to 100Mbit/s during the free trial.

**How can I set my domain to my cloud server?**

You will need to point your domain name to the public IP address of your cloud server at your domain name registrar. Learn more about domains at this [guide](/docs/guides/domain-name-system.md).

**How do I connect using SSH?**

You can use any SSH client you wish by connecting to the public IP address of your cloud server. Log in with the user “root” and your server password. Learn more about SSH at this [guide](/docs/guides/connecting-to-your-server.md).

## Network policies

**Do you allow outbound SMTP?**

Yes, but you must follow common good practices when sending any marketing emails. Spamming is strictly prohibited. As such the port 25 used by SMTP is blocked by default on all new accounts. You can learn more at our guide to [SMTP best practices](/docs/guides/sending-email-smtp-best-practices.md).

**What ports do you block on servers?**

During the free trial, we block some ports for security reasons but after making the first payment, all ports are unlocked with the exception of the port 25.

**How is data transfer outside monthly quota billed?**

Under our [Fair Transfer Policy](/docs/products/networking/network-transfer#fair-transfer-limit.md), there are no excess fees for exceeding your monthly transfer allowance. Instead, we provide generous outbound transfer shares that scale with your overall cloud spend. If you exceed your allocated transfer, we'll notify you and may reduce your Cloud Server bandwidth to 100 Mbps for the remainder of the month. For users requiring unlimited transfer without bandwidth restrictions, we offer an optional paid transfer model at €0.01 / $0.01 per GB. All inbound and private network traffic remains free of charge.
