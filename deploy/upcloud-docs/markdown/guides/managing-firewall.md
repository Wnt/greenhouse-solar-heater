# How to use the UpCloud firewall

Your UpCloud Control Panel offers an L3 firewall positioned just before the network interface connecting your cloud server to the internet. Therefore, it’s in a perfect position to secure all of the connections to your server. The firewall is configured per-server basis and billed according to our pricing.

Sign in to your [UpCloud Control Panel](https://hub.upcloud.com/), click on the server you wish to configure and open the firewall tab in your server settings.

Note that the UpCloud firewall is stateless and does not keep track of connections. Make sure to configure rules to allow both incoming and outgoing traffic.

## Managing the firewall

When you first open your firewall settings, the rules list will be empty and the firewall itself is disabled. If you already have active services running on the server, such as a website or a database, keep the firewall disabled until you have created all the required rules to avoid blocking connections while making configurations.

Click the toggle switch on the firewall panel to enable or disable the service.

![Firewall tab in server settings](img/image.png)

Before configuring new rules, first, check the Default Rule settings for both incoming and outgoing traffic rules. These define the baseline rule for any traffic in each direction when no other rules match the data packet in question.

The most common approach for a firewall configuration is to use the *Drop* as the default rule and define the rules list to accept the connections you want to allow. Usually, there is no need to block outgoing traffic as anything on your cloud server should be installed and configured intentionally by you, but the option is there in case you need to be more restrictive.

## Defining firewall rules

Start by setting the incoming traffic option to Default rule to *Drop*.

![Firewall tab view](img/image-1.png)

To allow connections on the incoming traffic rules, click the *Add rule* button, which will open a new firewall rule dialogue window. With the available rule options, you can precisely define which ports accept what kind of traffic and from where.

![Firewall add rule window](img/image-2.png)

However, if your cloud servers have more than just SSH and web services, creating all the rules manually could get tiresome. Instead, select *Import premade profile* from the drop-down menu just above your incoming rules.

![Firewall import rules](img/image-3.png)

You can then select a profile and read the short description of the rule set in the dialogue panel to get a better idea of what those premade profiles are meant for. Do not worry if none of the profiles seems to match your use case perfectly, you can always edit or add more rules later. For the moment, pick the one that gets the closest to what you are aiming for.

![Firewall import premade profile](img/image-4.png)

Once you’ve selected one, click the *Import rules* button to confirm.

This creates a group of inbound rules for allowing traffic based on the premade profile description. If you want to check out a different profile, just repeat the steps and select another group of rules to try. Similarly, you can copy rules between cloud servers by selecting *Import from another server* in the drop-down menu above your incoming rules table.

Finally, click the *Save changes* button on the right above your incoming rules table to apply the new rules.

![Firewall save changes](img/image-5.png)

The above example configuration is a standard web server listening at 80 and 443 for HTTP(S), 22 for SSH, and port 53 for DNS. Each rule shows twice to allow both IPv4 and IPv6 traffic including ICMP that ping commands use. The default rule for all other incoming connections is to drop so packets heading to any other ports will be denied access. All outgoing ports can be allowed with the Default rule Accept.

## Updating firewall rules

You can edit the rules created from the premade profiles just as any other manually added rules by clicking the pencil icon to the right of the rule row. It opens the dialogue panel to change an existing firewall rule with the current settings for that specific rule selected.

For example, you could disable the IPv4 ping reply for your server by editing the ICMP/IPv4 rule and selecting *Drop* from the Action menu. This retains the rule so you can easily allow it again if you wish instead of simply deleting the rule by clicking the bin icon. Save any changes by clicking *Ok*, or return without changing the rule by clicking *Cancel*.

![Firewall edit firewall rule](img/image-6.png)

Please note that the Default rule Drop/Accept matches both IPv4 and IPv6 protocols. If you have an IPv6 interface enabled on your server remember to add firewall rules for IPv6 traffic as well.

As with most firewall setups, the order of the rules also matters. All packets will be compared to the rules on a top-down basis, and the action is selected based on which rule matches the packet first. New rules you create are added to the bottom of the list, but you can change the order of the rules by simply dragging and dropping any rule on its list.

An example of using the rule order, for instance, if you wish to block all incoming IPv6 traffic, just create a new rule with Family: IPv6, Action: Drop and leave Protocol, Source, and Destination to “All”, then move that new rule to the top of the list using the arrows. This will supersede any other IPv6 rules below it regardless of their Action selection.

When you are done adding new or editing the existing rules, click the *Save changes* button again to apply the current set of rules to your firewall, then turn it on by clicking the toggle to Enabled.

## Summary

With the UpCloud Firewall configured and enabled your cloud server gets the extra protection it deserves. Thanks to the easy-to-use web console you don’t have to worry about locking yourself out of your server by accidentally blocking SSH connections. For more intricate connection policies, consider implementing a server-side software firewall, such as iptables, as well.
