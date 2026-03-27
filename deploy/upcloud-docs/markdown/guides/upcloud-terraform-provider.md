# UpCloud Terraform Provider

Terraform is a popular open-source infrastructure-as-code software tool created by HashiCorp. It allows users to define infrastructure as code using a simple, human-readable language to safely and predictably manage cloud infrastructure by codifying APIs into declarative configuration files.

Terraform works as a command-line utility that communicates with the supported services using provider modules. The UpCloud Terraform provider integrates Terraform with UpCloud’s infrastructure-as-a-service via the UpCloud API. It enables users to take full advantage of UpCloud’s products and services. Terraform and the UpCloud Terraform provider module include all the tools needed for users to manage their cloud infrastructure on UpCloud.

Terraform provider resources

- [UpCloud Terraform provider documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs)
- [UpCloud Terraform provider on GitHub](https://github.com/UpCloudLtd/terraform-provider-upcloud)

## Verified Terraform provider

UpCloud is a member of the HashiCorp Technology Partner Program and the authenticity of the UpCloud Terraform provider has been verified by Terraform to meet the highest standards. Terraform hosts the provider module on their Terraform Registry, however, UpCloud remains the owner and maintainer of the module.

![UpCloud Terraform provider ](img/image.png)

UpCloud Terraform provider

Terraform Registry directly integrates providers and modules with the Terraform CLI. To use any provider on the Registry, all the user needs to do is to include the provider in their Terraform configuration. Terraform will then automatically install the required components upon initialising the working directory.

As a verified provider, the [UpCloud Terraform module](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest) is available in the Terraform Registry. The UpCloud Terraform module can be installed automatically via Terraform by simply including the following in the Terraform configuration and then initialising the working directory.

```
terraform {
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }
}
```

Terraform configurations can then take advantage of any resources offered by the installed provider module.

The Terraform Registry is the main source for publicly available Terraform providers. It offers an index of modules and makes it possible for Terraform CLI to automatically install any of the providers it hosts.

In addition to being on the Terraform Registry, the UpCloud Terraform provider is [available open-source on GitHub](https://github.com/UpCloudLtd/terraform-provider-upcloud).

![](img/image-1.png)

Contributions from the community are always welcomed!

## Get started

Learn more about how Terraform works by taking it out for a spin by [following our guide series](/docs/guides/get-started-terraform.md). Alternatively, if you are already familiar with Terraform and would like to see it put to proper use, check out our new guide on how to deploy a [high-availability web application using Terraform](/docs/guides/deploy-high-availability-web-app-terraform.md).
