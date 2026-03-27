# High availability for VPN Gateways

All UpCloud VPN Gateway services are implemented with high availability in mind, using an active/passive availability model. In a highly available setup, multiple instances of VPN endpoints are deployed. Should the primary instance fail, the secondary instance will instantly replace the failed instance, with minimal interruption to the VPN connections.

## Supported plans

High availability is supported in all VPN Gateway plans:

- Production
- Advanced

See [pricing](https://upcloud.com/pricing/#managed-gateways) for more information on the plans.

## Automatic failover

The failover of a failed VPN instance is automatic and no user action is needed. The external IP address of the gateway service is automatically transferred to the hot spare.

The failover is expected to take approximately 30-120 seconds to fully reconfigure the VPN tunnels.

![Example of high availability](ha-model.png)

Example of a the secondary instance taking over the role of the failed primary instance.
