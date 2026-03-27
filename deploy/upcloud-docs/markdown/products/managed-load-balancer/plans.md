# Managed Load Balancer configurations

## Development plan

The Development plan allows users to test the service and begin developing applications without significant upfront investments.

Supporting up to 1000 concurrent sessions, the Development plan consists of a single node for handling small to medium workloads, suitable for low-traffic applications and development environments.

## Production plans

Applications and services that need higher capacity or want to enable high availability can scale up to the Production plan.

The Production plan include multiple parallel load-balancing nodes, each capable of handling up to 50,000 sessions. Forming a high availability cluster, the Production plan Load Balancer distributes workloads across all nodes in order to prevent any single node from getting overloaded.

## Configurations

| Plan | Nodes | Sessions per node |
| --- | --- | --- |
| Development | 1 | 1,000 |
| Production S | 2 | 50,000 |
| Production M | 5 | 50,000 |
