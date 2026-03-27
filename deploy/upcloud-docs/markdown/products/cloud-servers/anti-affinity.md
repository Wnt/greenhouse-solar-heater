# Anti-affinity for Cloud Servers

Cloud Servers can be placed into server groups which support anti-affinity. Anti-affinity is used to achieve better fault tolerance against hardware failures. During startup, servers belonging to the same anti-affinity group will be attempted to be placed on separate hosts. It is recommended to enable anti-affinity when servers provide a redundant role, for example being members of the same load balancer backend group.

UpCloud supports two anti-affinity policies: soft and strict.

With the soft policy, the Cloud Server is started even if anti-affinity cannot be met.
With the hard policy, starting with unmet anti-affinity will throw an error.
Note that in certain circumstances it might not always be possible to start all Cloud Servers on separate hosts. Depending on the selected anti-affinity policy, failing the anti-affinity requirement may cause the startup to fail.

The host selection is made each time the server is started from a stopped state. An unmet anti-affinity state can be attempted to be remediated by fully stopping the server and starting it up again.

## Additional resources

- Guide: [How to enable Anti-affinity using Server Groups with the UpCloud API](/docs/guides/anti-affinity-server-groups-upcloud-api.md)
