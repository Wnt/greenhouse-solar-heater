# Connecting to Managed MySQL

Managed Databases can be reached via the user’s SDN Private Network or Utility network, with the option for public network connectivity. By default, a private connection is enabled. When using SDN Private Networks, access is limited to Cloud Servers linked to those networks. Alternatively, with the Utility network, the database will be accessible from all Cloud Servers within the same data centre as the Managed Database.

For Utility networks, you can enable the automatic utility filter option to allow access to servers in the same zone. For SDN networks, the whole range of the SDN network is always whitelisted when you attach the network.

At the configuration settings, users can set a preferred hostname. The hostname is used to automatically create DNS entries using a unique subdomain name. Each Managed Database can have up to four DNS entries, one for private and another for public access, as well as read-only access for each.

- **Private:** example-mctapmghasah.db.upclouddatabases.com
- **Private read-only:** replica-example-mctapmghasah.db.upclouddatabases.com
- **Public:** public.example-mctapmghasah.db.upclouddatabases.com
- **Public read-only:** public-replica-example-mctapmghasah.db.upclouddatabases.com

MySQL is a registered trademark of Oracle and/or its affiliates. Other names may be trademarks of their respective owners.
