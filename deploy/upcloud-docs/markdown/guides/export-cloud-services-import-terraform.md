# How to export cloud resources and import to Terraform

[Terraform](https://upcloud.com/blog/upcloud-verified-terraform-provider/) is a simple yet powerful open-source infrastructure management tool that allows you to build, change, and version infrastructure safely and efficiently. While Terraform is great for building new cloud services, you can now also easily export UpCloud Control Panel managed configurations for importing to Terraform!

![Terraform logo](img/terraform-logo.png)

Terraform logo

In this guide, we will show you how to export your cloud services as ready-to-use Terraform configuration files and how to import these into Terraform. The process is really quick and easy allowing anyone to migrate to managing their cloud infrastructure using Terraform.

## Getting started with Terraform

Managing your cloud infrastructure on UpCloud is really straightforward using our Terraform provider module. It’s publicly available on our [GitHub](https://github.com/UpCloudLtd/terraform-provider-upcloud) as well as on [Terraform’s Registry](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest) which makes it simple to install. If you are new to Terraform on UpCloud or Terraform in general, have a look at our [getting started guide to install Terraform](/docs/guides/get-started-terraform.md) and set up your Terraform configuration directory.

## Exporting cloud resources

The Terraform command-line tool allows importing existing resources simply by providing it with matching configurations. However, this could be quite cumbersome even with smaller services let alone on 100+ cloud server infrastructure! To solve this, we offer an option to programmatically generate Terraform configuration from your existing UpCloud services.

To get started, head over to [Export .tf configuration page in UpCloud Control Panel](https://hub.upcloud.com/developer-tools/export).

![Selecting cloud resources for export](img/terraform-export-servers.png)

Selecting cloud resources for export

Select the resources you wish to manage via Terraform from now on. Note that selecting a resource will automatically select all of its dependencies.

Your cloud resources are arranged according to their types; servers, networks, databases, for example.

When you’ve made your selections, click the *Next* button to continue.

Lastly, confirm you have selected the cloud resources you want to export. Then click the *Next* button to run the export process.

![Summary for cloud resources to be exported](img/terraform-export-summary.png)

Summary for cloud resources to be exported

Once you’ve exported cloud resources at your UpCloud Control Panel, you will be presented with a Terraform configuration file and instructions on how to import it. Proceed to the next section to continue to import your resources to Terraform.

## Importing Terraform configurations

The exported configuration is presented in a single file and can be copied as such. However, you can also separate your resources into their own files.

Following our guide on [how to get started with Terraform](/docs/guides/get-started-terraform.md), you might have already created a configuration directory. If not, do so now by simply creating a folder where you wish to save your Terraform configuration. For example in your home directory.

```
mkdir -p ~/terraform/prod
```

Then create a file called main.tf in that directory and copy your Terraform configuration to it.

Make sure you include the *terraform* and *provider* sections as shown below.

![Exported Terraform configuration](img/terraform-export-config.png)

Exported Terraform configuration

When you’ve saved your Terraform configuration, you will need to initialise your Terraform directory.

```
terraform init
```

Next, run the import commands as displayed in the Terraform import instructions in your UpCloud Control Panel. The example below shows a list of commands. Note the && at the end of each line meaning the whole list can be executed as one command.

![Terraform import commands](img/terraform-import-commands.png)

Terraform import commands

When running the import commands, you should see a confirmation like the output example underneath for each import.

```
Import successful!

The resources that were imported are shown above. These resources are now in
your Terraform state and will henceforth be managed by Terraform.
```

Finally, test the import by running the terraform plan command to verify your configuration.

```
terraform plan
```

If you then want to make changes to your cloud services, simply amend the Terraform configuration files and apply the changes.

```
terraform apply
```

That’s it! You should now have successfully exported at least some of your cloud resources and imported them to Terraform.

## Conclusions

Importing your cloud resources to Terraform allows you to codify your infrastructure for easier maintenance and management. Furthermore, the export feature at your UpCloud Control Panel makes it easier than ever before to get started with Terraform.

After importing your first Terraform config, you might want to learn how to make the most of Terraform. For example, check out our guide on [how to use Terraform variables](/docs/guides/terraform-variables.md) to make it quick and easy to modify or replicate your cloud services.
