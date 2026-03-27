# Free trial

All new users are given a [free trial](https://signup.upcloud.com/) to evaluate UpCloud services without commitment. The free trial period allows you to [familiarise yourself](/docs/guides/quick-start-guide.md) with our services and test [UpCloud products](/docs/products.md) without commitment.

## Activating the trial

The trial does not begin automatically upon registration. The trial can be started at your own pace after creating an account and logging into the [UpCloud Control Panel](https://hub.upcloud.com/). Just verify your identity with a credit card and billing information to enter the free trial. Your credit card will not be charged before, during, or after the trial period, but we will make a 0 or 1 €/$ temporary authorisation to verify your card. We verify credit card details only to help us prevent bots and abuse.

Please note that the free trial needs to be started **within 365 days of registration**. After this period, new accounts that have not activated the trial will be removed.

## Duration

The free trial is offered to all new users and lasts for 7 days from the moment of trial activation.

Certain promotions may offer longer trial periods. You can request an extension to your trial period by [contacting our sales representatives](https://upcloud.com/contact/).

## Products included in the trial

You will get free access to test most of UpCloud’s services, including Cloud Servers, Networking, VPN or NAT Gateway, and Managed Services. Trial accounts are limited by the following quotas to prevent abuse. You are able to deploy, delete, and redeploy services as many times as you want during the trial within the quota limitations.

Note that you may get different options for your trial depending on current promotions and other offers.

| Product | Free trial |
| --- | --- |
| Cloud Servers | 2 cores, 4 GB memory, all OSs except Windows |
| Block Storage | Archive, Standard and MaxIOPS 60 GB each |
| Networks | 2 IPv4 and 2 IPv6 addresses |
| NAT / VPN Gateway | 1 Gateway with a Development or Standard plan |
| Managed Object Storage | 1 instance with 250 GB in size |
| Managed Databases | 1 DB with 1 node (MySQL, PostgreSQL, Valkey, OpenSearch) |
| Managed Load Balancer | 1 Development Plan, 1 node with 1000 sessions |
| Managed Kubernetes | 1 cluster with a Development Plan, worker nodes controlled by server quotas |

## Allowed network connections

Certain network ports are limited during the trial. The firewall is enabled and locked to limit both inbound and outbound connections to standard ports commonly used on web servers.

| Port | Service | Incoming | Outgoing |
| --- | --- | --- | --- |
| 22 | SSH | Yes | No |
| 25\* | SMTP | Yes | No |
| 80 | HTTP | Yes | Yes |
| 443 | HTTPS | Yes | Yes |
| 123 | NTP | Yes | Yes |
| 53 | DNS | No | Yes |
| 3389 | RDP | Yes | No |

\*The SMTP port (25) is blocked by default for all accounts. **Non-trial** users who wish to have their SMTP port unblocked should first review our [SMTP best practices](/docs/guides/sending-email-smtp-best-practices.md) guide, then contact our [Customer Support](https://upcloud.com/support/) team to request the unblocking of the port.

## Upgrading

### Before or during the trial period

You can upgrade your account to full access at any time by making a minimum one-time deposit of 10 in your chosen currency or more in the [Billing section at UpCloud Control Panel](https://hub.upcloud.com/account/billing).

Upgrading during the trial will retain any services you have already deployed.

The first payment includes a **30-day money-back guarantee**, of up to €500 / $500. If you are not happy with our services, please contact our [Customer Support](https://upcloud.com/support/) to request a refund.

### After the trial period

The account remains active until the trial ends and you will continue to be able to log into your UpCloud account after the trial.

When the trial expires, you will not be able to deploy new services before upgrading your account by making a [one-time payment](/docs/getting-started/accounts/account-balance/adding-balance-to-your-account.md) to your UpCloud account.

## When trial ends

If the trial ends without making at least the minimum payment, any services deployed during the trial are removed but the account remains active.

For standard 7-day trials, the free trial credits expire 7 days after account creation.

After the trial, you can continue using services by making at least a [one-time deposit](/docs/getting-started/accounts/account-balance/adding-balance-to-your-account.md) to your UpCloud account.
