# How to use Terraform variables

Variables in [Terraform](https://upcloud.com/blog/upcloud-verified-terraform-provider/) are a great way to define centrally controlled reusable values. The information in Terraform variables is saved independently from the deployment plans, which makes the values easy to read and edit from a single file.

In this guide, we’ll go over the types of available variables in Terraform, how to define them, and how to put them to use. You can use the general information about the variables as a quick cheat sheet but the examples are a direct continuation to our Terraform beginners article. If you haven’t installed Terraform yet, [follow the guide here to get started](/docs/guides/get-started-terraform.md).

## Terraform variables

Terraform supports a few different variable formats. Depending on the usage, the variables are generally divided into inputs and outputs.

The input variables are used to define values that configure your infrastructure. These values can be used again and again without having to remember their every occurrence in the event it needs to be updated.

Output variables, in contrast, are used to get information about the infrastructure after deployment. These can be useful for passing on information such as IP addresses for connecting to the server.

## Input variables

Input variables are usually defined by stating a name, type and default value. However, the type and default values are not strictly necessary. Terraform can deduct the type of the variable from the default or input value.

Variables can be predetermined in a file or included in the command-line options. As such, the simplest variable is just a name while the type and value are selected based on the input.

```
variable "variable_name" {}
```

```
terraform apply -var variable_name="value"
```

The input variables, like the one above, use a couple of different types: strings, lists, maps, and boolean. Here are some examples of how each type are defined and used.

### String

Strings mark a single value per structure and are commonly used to simplify and make complicated values more user-friendly. Below is an example of a string variable definition.

```
variable "template" {
  type = string
  default = "01000000-0000-4000-8000-000030080200"
}
```

A string variable can then be used in resource plans. Surrounded by double quotes, string variables are a simple substitution such as the example underneath.

```
storage = var.template
```

### List

Another type of Terraform variables lists. They work much like a numbered catalogue of values. Each value can be called by its corresponding index in the list. Here is an example of a list variable definition.

```
variable "users" {
  type    = list
  default = ["root", "user1", "user2"]
}
```

Lists can be used in the resource plans similarly to strings, but you’ll also need to denote the index of the value you are looking for.

```
username = var.users[0]
```

### Map

Maps are a collection of string keys and string values. These can be useful for selecting values based on predefined parameters such as the server configuration by the monthly price.

```
variable "plans" {
  type = map
  default = {
    "5USD"  = "1xCPU-1GB"
    "10USD" = "1xCPU-2GB"
    "20USD" = "2xCPU-4GB"
  }
}
```

You can access the right value by using the matching key. For example, the variable below would set the plan to `"1xCPU-1GB"`.

```
plan = var.plans["5USD"]
```

The values matching their keys can also be used to look up information on other maps. For example, underneath is a shortlist of plans and their corresponding storage sizes.

```
variable "storage_sizes" {
  type = map
  default = {
    "1xCPU-1GB"  = "25"
    "1xCPU-2GB"  = "50"
    "2xCPU-4GB"  = "80"
  }
}
```

These can then be used to find the right storage size based on the monthly price as defined in the previous example.

```
size = lookup(var.storage_sizes, var.plans["5USD"])
```

### Boolean

The last of the available variable type is boolean. They give the option to employ simple true or false values. For example, you might wish to have a variable that decides when to generate the root user password on a new deployment.

```
variable "set_password" {
  default = false
}
```

The above example boolean can be used similarly to a string variable by simply marking down the correct variable.

```
create_password = var.set_password
```

By default, the value is set to false in this example. However, you can overwrite the variable at deployment by assigning a different value in a command-line variable.

```
terraform apply -var set_password="true"
```

## Output variables

Output variables provide a convenient way to get useful information about your infrastructure. As you might have noticed, much of the server details are calculated at deployment and only become available afterwards. Using output variables you can extract any server-specific values including the calculated details.

Configuring output variables is really quite simple. All you need to do is define a name for the output and what value it should represent. For example, you could have Terraform show your server’s IP address after deployment with the output variable below.

```
output "public_ip" {
  value = upcloud_server.server_name.network_interface[0].ip_address
}
```

Note that the place of the public network interface on the list of network interfaces depends on which order the NICs are defined in the resources.

Terraform would then output the public IP address at the end of the apply command process. Alternatively, output variables can also be called on-demand using `terraform output` command. Next, continue on to set up a variable file for server configuration.

## Defining variables in a file

You should have a Terraform project with a basic plan already set up. If not, follow our [getting started guide for Terraform](/docs/guides/get-started-terraform.md) to begin.

Go to your Terraform project directory.

```
cd ~/terraform/base
```

Terraform variables can be defined within the infrastructure plan but are recommended to be stored in their own variables file. All files in your Terraform directory using the `.tf` file format will be automatically loaded during operations.

Create a variables file, for example, `variables.tf` and open the file for editing.

Add the below variable declarations to the variables file. Replace the SSH key private file path and the public key with our own.

```
variable "private_key_path" {
  type = string
  default = "/home/user/.ssh/terraform_rsa"
}

variable "public_key" {
  type = string
  default = "ssh-rsa terraform_public_key"
}

variable "zones" {
  type = map
  default = {
    "amsterdam" = "nl-ams1"
    "london"    = "uk-lon1"
    "frankfurt" = "de-fra1"
    "helsinki1" = "fi-hel1"
    "helsinki2" = "fi-hel2"
    "chicago"   = "us-chi1"
    "sanjose"   = "us-sjo1"
    "singapore" = "sg-sin1"
  }
}

variable "plans" {
  type = map
  default = {
    "5USD"  = "1xCPU-1GB"
    "10USD" = "1xCPU-2GB"
    "20USD" = "2xCPU-4GB"
  }
}

variable "storage_sizes" {
  type = map
  default = {
    "1xCPU-1GB" = "25"
    "1xCPU-2GB" = "50"
    "2xCPU-4GB" = "80"
  }
}
variable "templates" {
  type = map
  default = {
    "ubuntu18" = "01000000-0000-4000-8000-000030080200"
    "centos7"  = "01000000-0000-4000-8000-000050010300"
    "debian9"  = "01000000-0000-4000-8000-000020040100"
  }
}

variable "set_password" {
  type = bool
  default = false
}

variable "users" {
  type = list
  default = ["root", "user1", "user2"]
}

variable "plan" {
  type = string
  default = "10USD"
}

variable "template" {
  type = string
  default = "ubuntu18"
}
```

The above example is really just information storage. It uses the Terraform map variable for the most part which allows you to change the values to be more human-readable.

Variables set in the file can be overridden at deployment. This allows you to reuse the variables file while still customising the configuration at deployment. For example, although set\_password is false in the variables file, you could enable it on the command line.

```
terraform apply -var set_password="true"
```

In the same way, you could override the other variables as well.

## Loading variables automatically

The variables file as described in the previous section can easily be used across many configurations. However, if you need to make more than a couple of changes, it’s worth putting the customisation to a file too.

A variable definitions file uses the same basic syntax as Terraform language files but consists only of variable name assignments.

Terraform automatically loads a number of variable definitions files if named the following way:

Files named exactly `terraform.tfvars` or `terraform.tfvars.json`.
Any files with names ending in `.auto.tfvars` or `.auto.tfvars.json`.

Now, create a new file to define the custom variables called `terraform.tfvars` then add the following content.

```
set_password = "true"
users = ["root", "admin"]
plan = "20USD"
templates = {"ubuntu20":"01000000-0000-4000-8000-000030080200", "centos8":"01000000-0000-4000-8000-000050010300"}
template = "ubuntu20"
```

If you want to use JSON formatting instead, files with `.tfvars.json` ending are parsed as JSON objects. The root object properties correspond to variable names.

```
{
  "set_password": "true",
  "users": ["root", "admin"],
  "plan": "20USD"
  "templates": {"ubuntu20":"01000000-0000-4000-8000-000030200200", "centos8":"01000000-0000-4000-8000-000050010400"},
  "template": "ubuntu20"
}
```

Next, continue with the section below on how to put the variables in use.

## Using variables in resources

The values defined in the `variables.tf` files can be used in the Terraform plans to avoid hard-coding parameters. The following example uses the highlighted variables to select the parameters for deploying a new cloud server.

Notice the two last variables set in `variables.tf` which are used as selectors to choose the server plan and OS template.

```
resource "upcloud_server" "server1" {
  # System hostname
  hostname = "terraform.example.com"

  # Availability zone
  zone = var.zones["amsterdam"]

  # Number of CPUs and memory in GB
  plan = var.plans[var.plan]

  template {
    # OS root disk size
    size = lookup(var.storage_sizes, var.plans[var.plan])

    # Template UUID for Ubuntu 18.04
    storage = var.templates[var.template]
  }

  network_interface {
    type = "public"
  }
  network_interface {
    type = "utility"
  }
  # Include at least one public SSH key
  login {
    user = var.users[0]
    create_password = var.set_password
    keys = [
      var.public_key
    ]
  }

  connection {
    host = self.network_interface[0].ip_address
    type = "ssh"
    user = var.users[0]
    private_key = file(var.private_key_path)
  }
}
```

Terraform variables are useful for defining server details without having to remember infrastructure-specific values. They are similarly handy for reusing shared parameters like public SSH keys that do not change between configurations.

It is also important that the resource plans remain clear of personal details for security reasons. Using the variables, sensitive information such as private keys and usernames won’t get shared unintentionally.

## Defining output variables

Output variables provide a convenient way to get useful information about your infrastructure. As you might have noticed, much of the server details are calculated at deployment and only become available afterwards. Using output variables you can extract any server-specific values including the calculated details.

Configuring output variables is really quite simple. All you need to do is define a name for the output and what value it should correspond to. These can be included in your Terraform plan or in their own file.

Start by creating an output variables file called `output.tf` and open it for edit.

Add the following three variable definitions in the file to output the server’s IP addresses and hostname after deployment. Replace the `server_name` with the name of your Terraform host.

```
output "public_ip" {
  value = upcloud_server.server_name.network_interface[0].ip_address
}

output "utility_ip" {
  value = upcloud_server.server_name.network_interface[1].ip_address
}

output "hostname" {
  value = upcloud_server.server_name.hostname
}
```

Save the file and test the output by deploying the server with the usual commands below.

```
terraform plan
```

```
terraform apply
```

```
upcloud_server.server1: Creation complete after 39s (ID: 00b784aa-15c1-44dc-8252-f4bad865f853)

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

Outputs:

hostname = terraform.example.com
private_ip = 10.5.4.82
public_ip = 94.237.45.221
```

The variables you defined will be shown at the end of the deployment like in the example above. However, you can also retrieve these at any time using the Terraform command. For example, to get the public IP address, you can use the example command below.

```
terraform output public_ip
```

```
94.237.45.221
```

The same way you could ask Terraform about any other output variables.

## Using environmental variables

You can also set sensitive variables in your environment variables with the `TF_VAR_` prefix avoiding the need to save them in a file. For example, set your password in your local environmental variables.

```
export TF_VAR_PASSWORD="password"
```

You’ll also need to declare the password variable in your `variables.tf` file.

```
variable PASSWORD { default = "" }
```

The password variable is then usable in the Terraform resources.

```
  provisioner "remote-exec" {
    inline = [
      "useradd ${var.users[0]}",
      "echo '${var.users[0]}:${var.PASSWORD}' | chpasswd"
    ]
  }
```

When deployed, the remote execution provisioner will create a new user according to the users variable with the `PASSWORD` as set in the environmental variable.

## Summary

Terraform variables provide many convenient uses for infrastructure management. Dividing your deployment plan and configuration parameters into their own files helps to keep everything in order. However, that is just the general purpose of Terraform variables. Defining your infrastructure using variables is the first step towards the advanced features in Terraform.
