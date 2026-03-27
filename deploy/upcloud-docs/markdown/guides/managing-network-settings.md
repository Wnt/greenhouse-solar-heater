# Managing network settings

You can manage your cloud server network settings by adding and removing IP addresses or setting reverse DNS names. UpCloud does not currently offer hosted DNS services for your domain but you can find out more about our [DNS](/docs/guides/domain-name-system.md) settings in its own support article.

## Public network

[Public networks](https://hub.upcloud.com/networks/public) define the public IP addresses of your cloud servers. Every server can have 0-5 public IPv4 and IPv6 addresses. Removing all public addresses will make a server accessible only in your private network.

Adding new public IP addresses reserves the connections for your account but you’ll also need to configure the network interfaces in your operating system. Follow our guide to complete [attaching new IP addresses](/docs/guides/attaching-new-ip-addresses.md) with the steps appropriate for your server.

![Public networks](img/image.png)

## Private network

Your UpCloud account forms a secure [private network](https://hub.upcloud.com/networks/private) where servers are connected via private their IP addresses. Your private network is truly private and does not allow access from the internet or other UpCloud accounts. The private IP addresses are useful for load balancing and securely communicating between your servers.

![Private networks](img/image-1.png)

## Setting a reverse DNS name

Each public IP address on UpCloud has a generated default reverse DNS name. If you are intending to have a domain name point to your cloud server, it is also a good idea to set the reverse name accordingly.

The reverse DNS name can be edited either at your [public network](https://hub.upcloud.com/networks/public) list or at the *Network* tab in your [server settings](https://hub.upcloud.com/). Changing the reverse DNS name does not require your server to be shut down so go ahead and get started.

Click the pencil icon next to the current reverse DNS name you wish to edit and change it as needed. When done, click the save icon to confirm the changes.

![Edit reverse DNS name](img/image-2.png)

That is all. Your server IP should now report the new reverse DNS name when queried by other services. Do not worry if you still initially get the old name as the changes might take a moment to propagate through the network.
