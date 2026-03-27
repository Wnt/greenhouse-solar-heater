# UpCloud SDK FAQ

## General

**Do all SDKs have feature parity with the API?**

Our most extensive implementation is our [Go SDK](https://github.com/UpCloudLtd/upcloud-go-api) as it is used by many of the tools we offer, such as [Terraform](/docs/tooling/terraform-with-upcloud.md), [Packer](/docs/tooling/packer-with-upcloud.md) and [UpCloud CLI](/docs/tooling/cli.md).

[Python SDK](https://github.com/UpCloudLtd/upcloud-python-api) and [PHP SDK](https://github.com/UpCloudLtd/upcloud-php-api) have basic functionality built in, but they are lacking latest platform features.

**How do I report bugs, feedback or issues?**

Please reach out to us through project GitHub repositories:

- [Go SDK issues](https://github.com/UpCloudLtd/upcloud-go-api/issues)
- [Python SDK issues](https://github.com/UpCloudLtd/upcloud-python-api/issues)
- [PHP SDK issues](https://github.com/UpCloudLtd/upcloud-php-api/issues)

**When will you add a native library for language X?**

We are planning to release an OpenAPI specification. This will streamline new SDK implementations and make them easier to maintain.
