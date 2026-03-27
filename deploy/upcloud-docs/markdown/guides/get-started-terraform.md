# How to get started with Terraform

[Terraform](https://upcloud.com/blog/upcloud-verified-terraform-provider/) is a simple yet powerful open-source infrastructure management tool developed by HashiCorp. It allows you to safely and predictably manage your infrastructure by codifying APIs into declarative configuration files.

![Terraform logo](img/image.png)

Terraform logo

In this guide, we will show you how to install the required software and get started with Terraform on UpCloud. Below you can find the instructions suitable for most Linux distributions but Terraform is also available for download on macOS and Windows.

## Installing Terraform

Terraform works as a command-line utility that communicates with the supported services via APIs. Installing Terraform on your computer provides you with all the tools you need to manage your infrastructure in the cloud.

Start by heading to the [Terraform installation page](https://developer.hashicorp.com/terraform/downloads).

Select your operating system to find the appropriate installation instructions. E.g. using Ubuntu or Debian:

```
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
```

```
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
```

```
sudo apt update && sudo apt install terraform
```

Once installed, test that Terraform is accessible by checking for the version number in a terminal with the command underneath.

```
terraform -v
Terraform v1.4.5
```

That is it for Terraform itself. Next, continue below with the instructions for installing the prerequisites and the UpCloud provider plugin for Terraform.

## Setting up UpCloud user credentials

Deploying servers to your UpCloud account requires you to have your username and password safely stored in your environmental variables. Use the commands below to include an account name and password in your profile. Replace the `username` and `password` with your UpCloud account username and password.

```
echo 'export UPCLOUD_USERNAME=username' | tee -a ~/.bashrc
echo 'export UPCLOUD_PASSWORD=password' | tee -a ~/.bashrc
```

We recommend you create a new workspace member for API access. Find out more about [how to do this at our API guide](/docs/guides/getting-started-upcloud-api.md).

Then reload the profile to apply the new additions.

```
source ~/.bashrc
```

Afterwards, continue below to start your first Terraform project.

## Initialising new Terraform project

Each Terraform project is organised in its own directory. When invoking any command that loads the Terraform configuration, Terraform loads all configuration files within the working directory in alphabetical order. This is important to remember when configuring resources that might be dependent on one another.

Create a new directory for your Terraform project and change into it.

```
mkdir -p ~/terraform/base && cd ~/terraform/base
```

Deploying Cloud Servers on UpCloud using Terraform works using the [verified provider module](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest).

To start with using the UpCloud Terraform module requires you to declare the following configuration block. A standard name for a file with the following HCL is version.tf. Create the file with the below command then open it for editing with your preferred text editor.

```
touch version.tf
```

Next, add the following to the file.

```
terraform {
  required_providers {
    upcloud = {
      source = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }
}

provider "upcloud" {
  # Your UpCloud credentials are read from the environment variables
  # export UPCLOUD_USERNAME="Username for Upcloud API user"
  # export UPCLOUD_PASSWORD="Password for Upcloud API user"
  # Optional configuration settings can be declared here
}
```

Afterwards, save the file and exit the editor. With the required module declaration in place, you can get started.

Now, to begin a new configuration, every Terraform project directory needs to be initialised, do this by running the command below.

```
terraform init
```

Terraform sets up the directory to support deploying plans. You should see something like the example output below.

```
Initializing the backend...

Initializing provider plugins...
- Finding latest version of upcloudltd/upcloud...
- Installing upcloudltd/upcloud v2.1.0...
- Installed upcloudltd/upcloud v2.1.0 (self-signed, key ID 60B4E1988F222907)

Partner and community providers are signed by their developers.
If you'd like to know more about provider signing, you can read about it here:
https://www.terraform.io/docs/plugins/signing.md

Terraform has created a lock file .terraform.lock.hcl to record the provider
selections it made above. Include this file in your version control repository
so that Terraform can guarantee to make the same selections by default when
you run "terraform init" in the future.

Terraform has been successfully initialized!

You may now begin working with Terraform. Try running "terraform plan" to see
any changes that are required for your infrastructure. All Terraform commands
should now work.

If you ever set or change modules or backend configuration for Terraform,
rerun this command to reinitialize your working directory. If you forget, other
commands will detect it and remind you to do so if necessary.
```

The initialisation process creates a directory for the plugins in your Terraform folder under `.terraform/providers` and installs the UpCloud provider module.

The Terraform installation for UpCloud is then all set. You are now ready to start planning your first Terraform deployment. Continue on with the rest of the guide to learn how to create and deploy Terraform plans.

## Planning infrastructure with Terraform

Defining infrastructure as code brings many advantages such as simple editing, reviewing, and versioning, as well as easy sharing amongst team members.

Create a new build plan named for example `server1.tf` in your Terraform directory.

```
touch server1.tf
```

Open the file in your favourite text editor, then include a provider segment for UpCloud and any number of resources as described in the example plan below.

Replace the `ssh-rsa public key` in the login segment with your public SSH key and path to your private SSH key in the connection settings.

```
resource "upcloud_server" "server1" {
  # System hostname
  hostname = "terraform.example.com"

  # Availability zone
  zone = "nl-ams1"

  # Number of CPUs and memory in GB
  plan = "1xCPU-1GB"

  template {
    # System storage device size
    size = 25

    # Template UUID for Ubuntu 24.04
    storage = "01000000-0000-4000-8000-000030240200"
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
    keys = [ "ssh-rsa public key", ]
    create_password = false
  }

  # Configuring connection details
  connection {
    # The server public IP address
    host        = self.network_interface[0].ip_address
    type        = "ssh"
    user        = "root"
    private_key = file("~/.ssh/rsa_private_key")
  }

  # Remotely executing a command on the server
  provisioner "remote-exec" {
    inline = [ "echo 'Hello world!'" ]
  }
}
```

Once done, just save the file and you are good to go.

Note that Terraform needs to be able to read your private SSH key. If you get the following error:

```
Error: Failed to parse ssh private key: ssh: this private key is passphrase protected
```

Make sure it’s available and unlocked in your SSH agent or use a key that’s not password protected.

If you don’t have an SSH key at hand, check out our quick guide about [using SSH keys for authentication](/docs/guides/use-ssh-keys-authentication.md) to generate a key pair for Terraform.

## Deploying your configuration

Once you’ve defined your infrastructure plan, next you might want to deploy it. Terraform provides easy-to-use commands for safely and predictably deploying resources and applying changes to them.

First, verify your build plan with the following command.

```
terraform plan
```

This generates an execution plan that shows what actions will be taken when the plan is applied. It includes the server configuration, log in details, storage settings, and the deployment zone as seen in the example underneath.

```
Refreshing Terraform state in-memory prior to plan...
The refreshed state will be used to calculate this plan, but will not be
## persisted to local or remote state storage.
An execution plan has been generated and is shown below.
Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # upcloud_server.server1 will be created
  + resource "upcloud_server" "server1" {
      + boot_order           = (known after apply)
      + cpu                  = (known after apply)
      + firewall             = (known after apply)
      + hostname             = "terraform.example.com"
      + id                   = (known after apply)
      + labels               = {}
      + mem                  = (known after apply)
      + metadata             = true
      + nic_model            = (known after apply)
      + plan                 = "1xCPU-1GB"
      + tags                 = (known after apply)
      + timezone             = (known after apply)
      + title                = (known after apply)
      + video_model          = (known after apply)
      + zone                 = "nl-ams1"

      + login {
          + create_password   = false
          + keys              = [
              + "ssh-rsa public key",
            ]
          + password_delivery = "none"
          + user              = "root"
        }

      + network_interface {
          + bootable            = false
          + index               = (known after apply)
          + ip_address          = (known after apply)
          + ip_address_family   = "IPv4"
          + ip_address_floating = (known after apply)
          + mac_address         = (known after apply)
          + network             = (known after apply)
          + source_ip_filtering = true
          + type                = "public"
        }
      + network_interface {
          + bootable            = (known after apply)
          + index               = (known after apply)
          + ip_address          = (known after apply)
          + ip_address_family   = "IPv4"
          + ip_address_floating = (known after apply)
          + mac_address         = (known after apply)
          + network             = (known after apply)
          + source_ip_filtering = true
          + type                = "utility"

      + template {
          + address = (known after apply)
          + address_position         = (known after apply)
          + delete_autoresize_backup = false
          + encrypt                  = (known after apply)
          + filesystem_autoresize    = false
          + id                       = (known after apply)
          + size                     = 25
          + storage                  = "01000000-0000-4000-8000-000030240200"
          + tier                     = (known after apply)
          + title                    = (known after apply)
        }
    }

Plan: 1 to add, 0 to change, 0 to destroy.
```

The values shown are assigned at deployment and cannot be determined ahead of time. They can be queried once the server is online.

Next, deploy the configuration by executing the plan with the command below.

```
terraform apply
```

Reply `yes` when asked to confirm the deployment. Example output is shown below.

```
upcloud_server.server1: Creating...
upcloud_server.server1: Still creating... [10s elapsed]
upcloud_server.server1: Still creating... [20s elapsed]
upcloud_server.server1: Still creating... [30s elapsed]
upcloud_server.server1: Provisioning with 'remote-exec'...
upcloud_server.server1 (remote-exec): Connecting to remote host via SSH...
upcloud_server.server1 (remote-exec):   Host: 94.237.110.77
upcloud_server.server1 (remote-exec):   User: root
upcloud_server.server1 (remote-exec):   Password: false
upcloud_server.server1 (remote-exec):   Private key: true
upcloud_server.server1 (remote-exec):   Certificate: false
upcloud_server.server1 (remote-exec):   SSH Agent: false
upcloud_server.server1 (remote-exec):   Checking Host Key: false
upcloud_server.server1 (remote-exec):   Target Platform: unix
upcloud_server.server1 (remote-exec): Connected!
upcloud_server.server1 (remote-exec): Hello world!
upcloud_server.server1: Creation complete after 1m43s [id=00be4aad-9b82-435a-97f7-5d1496a11c81]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

You’ll notice that much of the output from the apply command looks the same as planning so some of the above are truncated for brevity. Terraform performs syntax verifications again in an effort to spare you from deployment errors that could take precious time to roll back.

Separating the plan and applying commands reduces mistakes and uncertainty at scale. Plans show operators what would happen upon the apply command to execute changes.

## Managing resources

When you need to make changes to your infrastructure, simply update the configuration file and apply the changes. As the configurations change, Terraform determines what is different and creates an incremental execution plan to perform the updates.

Open your Terraform plan in an editor and find the server configuration plan. Change the plan to increase the resources allocated to your server. You can see the available preconfigured plans in your [UpCloud control panel](https://hub.upcloud.com/deploy).

```
resource "upcloud_server" "server1" {
  # System hostname
  hostname = "terraform.example.com"

  # Availability zone
  zone = "nl-ams1"

  # Number of CPUs and memory in MB
  plan = "1xCPU-2GB"
...
}
```

Save the file with the changes, then verify your build plan again.

```
Refreshing Terraform state in-memory prior to plan...
The refreshed state will be used to calculate this plan, but will not be
persisted to local or remote state storage.

upcloud_server.server1: Refreshing state... [id=00be4aad-9b82-435a-97f7-5d1496a11c81]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # upcloud_server.server1 will be updated in-place
  ~ resource "upcloud_server" "server1" {
      ~ cpu         = 1 -> (known after apply)
        id          = "00be4aad-9b82-435a-97f7-5d1496a11c81"
      ~ mem         = 1024 -> (known after apply)
      ~ plan        = "1xCPU-1GB" -> "1xCPU-2GB"
        tags        = []
...
```

Finally, apply the change to see the results. Reply `yes` again to confirm when requested.

```
terraform apply
```

```
upcloud_server.server1: Refreshing state... [id=00be4aad-9b82-435a-97f7-5d1496a11c81]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # upcloud_server.server1 will be updated in-place
  ~ resource "upcloud_server" "server1" {
      ~ cpu         = 1 -> (known after apply)
        id          = "00be4aad-9b82-435a-97f7-5d1496a11c81"
      ~ mem         = 1024 -> (known after apply)
      ~ plan        = "1xCPU-1GB" -> "1xCPU-2GB"
        tags        = []
        # (10 unchanged attributes hidden)

        # (4 unchanged blocks hidden)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

upcloud_server.server1: Modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81]
upcloud_server.server1: Still modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 10s elapsed]
upcloud_server.server1: Still modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 20s elapsed]
upcloud_server.server1: Still modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 30s elapsed]
upcloud_server.server1: Still modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 40s elapsed]
upcloud_server.server1: Still modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 50s elapsed]
upcloud_server.server1: Still modifying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 1m0s elapsed]
upcloud_server.server1: Modifications complete after 1m6s [id=00be4aad-9b82-435a-97f7-5d1496a11c81]
```

You will see Terraform modify the server resources according to the differences between the server’s current state and the new plan.

In the same way, you could decrease the resources allocated to your cloud server by changing the plan back to `1xCPU-1GB`. However, note that this does not automatically resize the disk. As while increasing the disk is simple, decreasing storage is not quite straightforward. We recommend keeping your storage small if you wish to vertically scale the server and retain the preconfigured pricing.

When you are done with the test server, it can be deleted using the command underneath.

Note that the destroy command will delete all resources configured in that Terraform directory. In practical use, you should remove the resource configuration and use the apply command to update your infrastructure. Terraform will then figure out the differences in the live deployment and apply the necessary changes.

```
terraform destroy
```

```
upcloud_server.server1: Refreshing state... [id=00be4aad-9b82-435a-97f7-5d1496a11c81]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy

Terraform will perform the following actions:

  # upcloud_server.server1 will be destroyed
  - resource "upcloud_server" "server1" {
      - boot_order  = "disk" -> null
      - cpu         = 1 -> null
      ...
    }

Plan: 0 to add, 0 to change, 1 to destroy.

Do you really want to destroy all resources?
  Terraform will destroy all your managed infrastructure, as shown above.
  There is no undo. Only 'yes' will be accepted to confirm.

  Enter a value: yes

upcloud_server.server1: Destroying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81]
upcloud_server.server1: Still destroying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 10s elapsed]
upcloud_server.server1: Still destroying... [id=00be4aad-9b82-435a-97f7-5d1496a11c81, 20s elapsed]
upcloud_server.server1: Destruction complete after 21s

Destroy complete! Resources: 1 destroyed.
```

Check that the action about to be taken is correct and confirm the command by entering `yes` just as with previous `apply` commands.

## Summary

Great job completing this guide! You should now have some resources and the basic knowledge to start building upon. This is but an introduction to Terraform which has many advanced features. Check out the Terraform [documentation to learn more](https://www.terraform.io/docs).
