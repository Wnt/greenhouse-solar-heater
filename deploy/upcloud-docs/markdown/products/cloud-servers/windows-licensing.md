# Using Microsoft Windows on Cloud Servers

Cloud Servers can be deployed with Microsoft Windows Server through our provided templates. To ensure license compliance and proper functionality, there are several important considerations to understand before deploying Windows workloads.

## Windows Server licensing

Windows Server licenses must be obtained directly through UpCloud as we are an authorized Microsoft Services Provider. The licensing model is core-based, meaning there is a licensing charge on each CPU core assigned to your Cloud Server. You can find detailed pricing information on our [pricing page](https://upcloud.com/pricing).

To help optimize licensing costs, we offer [High Memory server plans](/docs/products/cloud-servers/plans#general-purpose-plans.md) that provide increased RAM while using fewer CPU cores. This can significantly reduce your Windows Server licensing expenses for memory-intensive workloads.

## License Mobility Agreement

Before deploying Microsoft software on UpCloud, you must have a signed Microsoft License Mobility Agreement (MLMA) in place. This agreement is crucial as it enables you to:

- Use Windows Server on UpCloud's infrastructure
- Bring your existing Microsoft application licenses to UpCloud
- Deploy applications like SQL Server, Exchange Server, and SharePoint Server

The license agreement is signed on the UpCloud control panel before deploying the first Windows Server instance on your account.

## KMS licensing and activation

Windows Server activation on UpCloud is handled through our Key Management Service (KMS). Your Windows Server must maintain regular contact with our KMS server at `169.254.169.254:1688` to stay properly activated.

The KMS service is available through:

- Public networks
- Utility networks
- SDN private networks

To ensure successful activation, configure your firewall rules to allow traffic to `169.254.169.254` on port `1688`. Please note that the KMS service is exclusively available to servers running on UpCloud's infrastructure and it cannot be used to activate servers hosted elsewhere.

## Limitations

The following limitations apply when running Windows Server on UpCloud:

- Only Windows Server instances deployed from UpCloud-provided templates are supported
- All Windows Server deployments must use UpCloud-provided licensing
- Custom Windows Server images can only be used by an explicit approval from UpCloud
- Existing Windows Server installations from other environments cannot be migrated
- License Mobility Agreement is required before deploying Windows workloads

## Migration considerations

When planning to use Windows Server on UpCloud, be aware that existing Windows Server installations cannot be migrated directly to our platform. This limitation exists to ensure proper licensing and activation through our KMS infrastructure.

Instead, you must:

1. Deploy a new Cloud Server using our Windows Server templates
2. Install your applications fresh on the new server
3. Migrate your data and configurations to the new installation

This approach ensures full compatibility with our licensing system and provides the best possible experience for running Windows Server workloads on UpCloud.
