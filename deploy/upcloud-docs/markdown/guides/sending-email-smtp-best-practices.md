# Sending email and SMTP best practices

The Simple Mail Transfer Protocol or SMTP is the Internet standard for sending and receiving emails. Email clients use SMTP to send messages to a mail server for delivery while email servers use it to forward messages to their recipients.

Outgoing emails are usually sent using port 587 or 465 while port 25 is used for relaying the message between mail servers.

Much of the email delivery depends on the reputation of the sender. Therefore, it’s important to follow common courtesy and best practices when operating a mail server. In this guide, we are going over a couple of things you need to consider before setting up an email server in the cloud.

## Preventing open SMTP relay misuse

SMTP port 25 is traditionally blocked by residential ISPs and cloud providers to prevent spam. This is to prevent open SMTP relays from being misused or set up for abuse.

Configuring up your own email server requires due care to ensure security. A simple mistake in the setup can render the security settings ineffective, therefore most important part is to make sure the server does not become an open relay.

Conveniently MX Toolbox, an online network testing utility, provides an [SMTP diagnostics tool](https://mxtoolbox.com/diagnostic.aspx) with which you can easily test your configuration by just entering your mail server domain name such as *mail.example.com*.

## Using secure SMTP connections

Secure mail submission usually takes place using a TLS-encrypted connection to port 587 of a server that submits the mail onwards. Both the client and server need to support it for a secure connection to be established. Most of the popular modern email clients support TLS, so the burden of enabling secure email delivery falls on mail server management.

It’s important to configure SMTP clients to require TLS for outgoing connections because the initial handshake takes place in plain text. A man-in-the-middle attack could otherwise make it appear that TLS is unavailable. This type of attack can be blocked by explicitly requiring TLS.

## Utilising professional mailing services

Although the outbound SMTP port 25 is blocked, you can choose to use ports 465 and 587, or a non-standard port to send email through a relay. For example, you can configure your Mail Transfer Agent to use a mailing service e.g. [MailChimp](https://mailchimp.com/) or [Mailgun](https://www.mailgun.com/) over port 587 to securely relay emails.

Alternatively, you might not want to run your own email server at all. Depending on your intended use for sending emails, you should consider utilising one of the aforementioned dedicated mailing services. Marketing campaigns and transactional emails are often best left to professionals to ensure reliable delivery.

## Opening SMTP port 25

The outbound SMTP port 25 is closed by default on new accounts to prevent accidental open relays and misuse. The blocked port shows up on your server’s firewall at your UpCloud control panel but cannot be changed directly.

The port can be opened on request. If you would need port 25 opened, you can request the port block to be removed by contacting our [support](https://upcloud.com/contact/) team.

You will be required to provide proof of identity or payment method for verification and explain your use case and why the outbound port 25 is needed. This is done to ensure the responsible use of SMTP and build trust in our network for email delivery.

Please note that we may be forced to close the outbound SMTP port 25 again due to evidence of a compromised server or the detection of spam.
