# Managed Load Balancer SSL Certificates

Managed Load Balancer service includes a built-in SSL certificate management system that enables users to dynamically obtain certificates or manually upload existing ones. Including an SSL certificate bundle to a Load Balancer frontend allows users to enable a secure connection via HTTPS.

These features are available at the UpCloud Control Panel as well as via the UpCloud API.

## Manual

The Manual mode lets users import existing SSL certificate bundles.

Users are able to upload their SSL certificate, any included intermediaries, and the corresponding private key to create certificate bundles. These are usually obtained together via the service used to generate and authenticate the certificates.

## Dynamic

The Dynamic mode sets a request to generate a new SSL certificate when attached to a Load Balancer frontend.

Creating a dynamic SSL certificate bundle allows users to obtain certificates directly to their Load Balancer by creating the necessary DNS records to demonstrate their authority over the claimed domain names.
