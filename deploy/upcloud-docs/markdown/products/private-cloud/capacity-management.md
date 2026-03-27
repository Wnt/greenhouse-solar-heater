# Capacity management in Private Clouds

UpCloud's Private Cloud service brings the visibility to the hosts Cloud Servers are run on. The full capacity of the hosts are dedicated only for your workloads. Hosts come with a preconfigured amount of CPU cores and memory, which can be distributed as desired between your Cloud Servers.

## Visibility to Cloud Server hosts

Visibility to Private Cloud hosts is available through the Hub, from the Private Cloud menu.
With this feature, you are able to monitor the total CPU and memory usage on the hosts.

![Private cloud hosts visibility on the Hub](private-cloud-hosts.png)

## CPU and memory management

Private Cloud hosts come with a set amount of CPU and memory, which can be freely distributed between your Cloud Servers. Due to the dynamic nature of the [block storage system](/docs/products/block-storage/storage-system.md) used on UpCloud, servers running on one host can be shut down and immediately started on another host without having to migrate any data.

Memory is a limited resource which is consumed according to the combined size of the servers started on the host.

CPU, on the other hand, is consumed only when the virtual CPUs are used by the Cloud Servers. CPU cores assigned to servers on a host are presented as vCPUs. The number of vCPUs available to Cloud Servers is not limited, and the only limit is the total processing power of the CPUs available on the host. Therefore the number of vCPUs allocated to the Cloud Server only control the maximum amount of CPU time the Cloud Server can get from the host.

Private Clouds can be expanded by adding extra hosts or by replacing hosts with larger ones.

## Cherry picking hosts

Private Clouds enable precise control on which hosts each Cloud Server is started on. This enables cherry picking hosts, which is prioritised in host selection over [anti-affinity](/docs/products/cloud-servers/anti-affinity.md).

![Private cloud host selection](host-selection.png)
