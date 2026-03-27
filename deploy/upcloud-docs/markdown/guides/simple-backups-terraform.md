# How to manage Simple Backups using Terraform

[Terraform](https://upcloud.com/blog/upcloud-verified-terraform-provider/) is a simple yet powerful open-source infrastructure management tool developed by HashiCorp. Terraform allows you to safely and predictably manage everything around your Cloud Servers, including Simple Backups, by codifying APIs into declarative configuration files.

![Terraform logo](img/terraform_logo.png)

Terraform logo

Building your cloud setup around Terraform is a great way to configure something once and be able to deploy it again and again with no effort at all. In this guide, we will show how to manage Simple Backups using Terraform.

## Getting started

Managing your cloud resources on UpCloud using Terraform works via our [verified provider module](/docs/guides/upcloud-terraform-provider.md). With the UpCloud Terraform provider, it is as simple as declaring the required providers in a configuration file and then giving Terraform something to do.

In practice, you need to allow Terraform to access your UpCloud account by setting an account name and password in your environmental variables. If you haven’t done so already, check out our [Terraform intro tutorial](/docs/guides/get-started-terraform.md) to set your API credentials before continuing with the rest of this tutorial.

## Creating a basic Cloud Server

Managing cloud infrastructure using Terraform makes it simple to edit, review, and version, as well as easy to share amongst team members. This includes everything related to Cloud Servers and of course Simple Backups. However, before you can enable Simple Backups, you first need a Cloud Server.

If you have already configured Cloud Servers with Terraform, feel free to skip to the next section.

First, create a new Terraform configuration, for example, simple-backup-example.tf in your Terraform directory.

```
touch simple-backup-example.tf
```

Open the file in your favourite text editor then include the resource section as described in the example configuration below.

Replace the ssh-rsa public key in the login segment with your public SSH key and path to your private SSH key in the connection settings.

```
resource "upcloud_server" "simple-backup-example" {
  # System hostname
  hostname = "simple-backup-example.com"

  # Availability zone
  zone = "nl-ams1"

  # Number of CPUs and memory in GB
  plan = "1xCPU-1GB"

  template {
    # System storage device size
    size = 25

    # Template UUID for Ubuntu 20.04
    storage = "01000000-0000-4000-8000-000030200200"
  }

  # Network interfaces
  network_interface {
    type = "public"
  }

  network_interface {
    type = "utility"
  }

  # Include at least one public SSH key
  login {
    user = "root"
    keys = [
      <span>"ssh-rsa public key"</span>,
    ]
    create_password = true
    password_delivery = "email"
  }

  # Configuring connection details
  connection {
    # The server public IP address
    host        = self.network_interface[0].ip_address
    type        = "ssh"
    user        = "root"
    private_key = file(<span>"~/.ssh/rsa_private_key"</span>)
  }

  # Remotely executing a command on the server
  provisioner "remote-exec" {
    inline = [
      "echo 'Hello world!'"
    ]
  }
}
```

Once done, just save the file and you are good to go.

When you’ve defined your Cloud Server configuration, next you need to deploy it. Terraform provides easy-to-use commands for safely and predictably deploying resources and applying changes.

First, verify your build plan with the following command.

```
terraform plan
```

This generates an execution plan that shows what actions will be taken when the plan is applied. It includes the server configuration, log-in details, storage settings, and the deployment zone.

Next, deploy the configuration by executing the plan with the command below.

```
terraform apply
```

Reply yes when asked to confirm the deployment.

Terraform performs syntax verifications again in deployment to spare you from configuration errors that could take precious time to roll back.

Separating plans and applying commands reduces mistakes and uncertainty at scale. Plans show operators what would happen when executing changes with the apply command.

## Configuring Simple Backups

Simple Backups are the easy way to back up your Cloud Servers. It saves a full snapshot of the state of your Cloud Server, backing up everything in one go without interruption or slowing down the running Cloud Server.

Configuring Simple Backups using Terraform is as simple as including the following instruction block in your Cloud Server configuration.

```
resource "upcloud_server" "simple-backup-example" {
  ...
  template {
    # System storage device size
    size = 25

    # Template UUID for Ubuntu 20.04
    storage = "01000000-0000-4000-8000-000030200200"
  }

  # Simple Backups
  simple_backup {
    plan = "dailies"
    time = "2200"
  }
  ...
}
```

The Simple Backup configuration block includes two required parameters, plan and time:

- **Plan** lets you choose how long your backups are kept. The options “dailies”, “weeklies”, and “monthlies” retain backups for a week, month and year respectively.
- **Time** sets the time of the day format the backup is taken within a 24-hour. You might want to choose a time during lower usage and stagger the backups if you have multiple servers.

Once you are all set, just save the file and apply the changes.

```
terraform apply
```

Again, reply yes when asked to confirm.

Terraform will then detect the requested changes and apply them in place without any additional steps or downtime.

Enable and forget, with Simple Backups configured, you can rest easy knowing your data is safe! You don’t need to configure backup schedules or retention periods, just pick the backup duration you are likely to need and Simple Backups will the rest.

Furthermore, if you ever want to make changes to the backup plan or time, just update your configuration file and apply the changes using Terraform.

## Disabling Simple Backups

Enabling Simple Backups using Terraform is really easy and disabling it is just as simple. In practice, you just need to remove the simple\_backup configuration block. This can be done by deleting the entry from your configuration file. Alternatively, like in the example below, you can comment out the block by adding *#*-charater to the start of each line.

```
resource "upcloud_server" "simple-backup-example" {
  ...
  template {
    # System storage device size
    size = 25

    # Template UUID for Ubuntu 20.04
    storage = "01000000-0000-4000-8000-000030200200"
  }

  # Simple Backups
  #simple_backup {
  #  plan = "dailies"
  #  time = "2200"
  #}
  ...
}
```

When ready, save the file and apply the changes.

```
terraform apply
```

Reply yes when asked to confirm.

Terraform will compare the configuration file to the existing infrastructure and make the required changes to achieve the configured state.

Note that **disabling the Simple Backup plan does not delete existing backups** but instead converts them to flexible backups. When you no longer need the backups, you will need to delete them manually via either your UpCloud Control Panel or the API.
