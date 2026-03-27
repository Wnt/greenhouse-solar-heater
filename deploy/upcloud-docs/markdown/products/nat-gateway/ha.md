# High availability for NAT Gateways

UpCloud NAT Gateways are implemented with high availability in mind, using an active/passive availability model. In a highly available setup, multiple NAT instances are deployed. Should the primary instance fail, the secondary instance will instantly replace the failed instance, with minimal interruption to connections.

## Supported plans

High availability is supported in all but the Developer plan:

- Standard
- Production
- Advanced

See [configurations](/docs/products/vpn-gateway/configurations.md) for more information on the plans.

## Automatic failover

The failover of a failed NAT Gateway instance is automatic and no user action is needed. The external IP address of the gateway service is automatically transferred to the secondary instance.

The failover is expected to take approximately 30-120 seconds.

![Example of high availability](ha-model.png "Example of a the secondar instance taking over the role of the failed primary instance.")

Example of a the secondar instance taking over the role of the failed primary instance.
