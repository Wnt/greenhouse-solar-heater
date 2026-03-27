# Domain Name System and how to manage DNS records

The Internet at large runs on numbers, IP addresses, that are great for computers to work with but difficult for people to remember. To help with this, we assign names to these numbers using the Domain Name System, or DNS for short. Domain name records are used as a naming system for computers, servers, and other services on the Internet, much like a phonebook that matches names with numbers.

DNS is a hierarchical, decentralized method of assigning and mapping domain names to Internet resources. Domain Name Systems delegate the responsibility of name assignment and mapping by designating authoritative name servers for each domain. Furthermore, the authority over sub-domains can be delegated onwards to allocate namespaces to other name servers. This design avoids a single large centralized database by distributing the data to build a fault-tolerant service.

We at UpCloud maintain local DNS resolvers at each of our data centres. However, these servers are not user configurable and cannot be used to host users’ domain name records. Find out more about our [DNS resolvers and how to allow connections to them at your firewall](/docs/guides/dns-servers.md) at a separate guide.

## Domain name registrars

The hierarchy of domains starts with the top-level domains (TLDs) such as .com, .org, or .net. The information about domains is maintained by domain name registries who contract domain registrars to provide domain registration services to the end users. Thanks to the separation from the registries, users have a choice between a large number of domain registrars.

When a user purchases a domain from a registrar, that registrar becomes the designated registrar for the selected domain. With the assignment of authority, only the designated registrar may modify or delete information about the chosen domain name and its sub-domains. This method secures the domain for the user with the option to transfer domains between registrars. The registry information about a domain name and the designated registrar can be looked up at many services such as [ICANN’s WHOIS](https://whois.icann.org/en/lookup).

## Domain name records

Even though decentralized, the information about domain names still needs to be recorded and stored. Domain name records are kept by authoritative DNS servers that are commonly hosted by the domain registrar. In addition to hosting the records, an authoritative DNS server is allowed to create, edit, and delete records for the domains delegated to it. Due to this, most registrars offer their users a way to manage the domain name records without deeper knowledge of the inner workings of DNS servers.

However, it’s important to understand the basics of DNS records. Each domain can have many different types of records that serve different purposes. In essence, DNS records create a set of instructions that allow Internet users to find their destination website.

Below is a short list of the most commonly used DNS record types:

- **A record** holds the IPv4 address of a domain and is the most important of these records. One domain or sub-domain can have a single IP, while one IP can have multiple domains pointing to it.
- **AAAA record** is essentially the same as A record but for IPv6 addresses.
- **PTR record** finds a domain name in a reverse-lookup when the IP is already known. IP addresses usually have one PTR record each, but multiple PTR records can point to the same domain.
- **CNAME record**, or canonical name, forwards a domain or sub-domain to another domain without providing an IP address. These can be used as aliases for domains.
- **MX record** is the mail exchange record that directs mail to an email server. It indicates how email should be routed to its destination.
- **TXT record** lets a domain administrator store text notes in the record. These are commonly used to gauge the trustworthiness and verify ownership of a domain.
- **NS record** indicates the authoritative name servers. A domain often has multiple name servers, primary and secondary, to prevent outages in case of failures.

You can check any existing records using domain name lookup tools such as nslookup or dig.

```
nslookup example.com
nslookup -q=ns example.com
```

```
dig example.com
dig example.com txt
```

These lookup tools can be very useful when troubleshooting issues with domain name records.

## Creating domain A records

Deploying just about any kind of web application or service often requires setting up a domain name. A valid domain is needed, for example, to obtain SSL certificates or just to allow users to find your application by name.

A record is commonly configured using the following settings:

- The hostname for the record, without the domain name, creates a “subdomain”. Alternatively, @ can be used to refer to the domain name itself.
- An IPv4 address the A record should point to, usually your server’s first public IPv4 address. Private IPs cannot be reached from outside your own private network and, therefore, are not used for this.
- TTL sets the time-to-live in seconds. This is the amount of time the record is cached by a resolver. Time-to-live can be different between domain records and affect how fast the changes will take to propagate through the network, with longer TTL making updates slower. Commonly in the range of 300 – 86400 seconds, or 5 mins to 24 hours.

As an example, you could add a subdomain for your application server such as *git.example.com* and enable an A record that points to that subdomain.

- DNS A record, that maps your domain name to the server’s public IP address.

```
Name                       Type            Address                   TTL
git.example.com            A               83.136.253.111            300
```

The actual process of creating domain name records will depend on the domain name registrar you are using to manage your domain. Luckily, most registrars provide instructions or documentation on how to configure your domain name records. Below is a list of popular registrars with links to relevant instructions.

|  |  |  |  |
| --- | --- | --- | --- |
| DNSMadeEasy | Domain.com | Dotster | DreamHost |
| EasyDNS | Enom | FlokiNET | Gandi |
| GoDaddy | Google Domains | HostGator | HostMonster |
| iPage | MediaTemple | MelbourneIT | Moniker |
| Namecheap | Name.com | Network Solutions | OVH |
| Rackspace | Register | Tucows | Yola |

Setting up a domain name record will take a moment to propagate to other DNS servers so it is good to get them done early. Contact your registrar’s support centre for the most accurate information.

## Setting up PTR records

A domain PTR record is used in reverse lookups to find the domain name associated with a given IP address. These are not always required but, for example, an email server should have one configured for better mail delivery. As opposed to other domain name records, a reverse name record is configured by the IP address owner instead of the domain registrar.

You can set the reverse DNS name on each of your public IP address at your [UpCloud control panel](https://hub.upcloud.com/) under the *Network* tab in your server settings.

- Click the pencil icon to edit the Reverse DNS Name of your IP address
- Enter the domain name you want the PTR record to point to
- Click the accept icon to save the changes

![PTR records](img/image.png)

Setting a Reverse DNS Name allows servers to check what domain your server’s IP address belongs to. Every server on UpCloud has a default reverse name set at deployment, if you do not wish to set a PTR record yourself, the default value will be used.

## Summary

Domain names are great for setting up recognisable and trustworthy services. While the actual process of creating DNS records will largely depend on your domain name registrar, the configuration options are mostly the same. In case you need more help, consult your domain registrar’s documentation for more in-detail instructions on how to create domain name records.

Anyone who has purchased a domain can assign A records at their registrar’s management portal and PTR records at the UpCloud control panel. If you are looking to deploy web apps, even if just for development use, setting up a domain will help you build production-grade services. Furthermore, should you wish to dive way deeper into domain name systems, [deploy your own DNS server by following the guide for NIC tools](https://upcloud.com/resources/tutorials/nictool-dns-setup/).
