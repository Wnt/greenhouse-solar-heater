# How to configure Managed Databases using Terraform

[Terraform](https://upcloud.com/blog/upcloud-verified-terraform-provider/) is a simple yet powerful open-source infrastructure management tool developed by HashiCorp. Terraform allows you to safely and predictably manage everything from Cloud Servers to Object Storage and Managed Databases by codifying APIs into declarative configuration files.

![Terraform logo](img/image.png)

Building your cloud setup around Terraform is a great way to configure something once and be able to deploy it again and again with no effort at all. In this guide, we will show how to configure Managed Databases using Terraform.

## Prerequisites

Terraform integrates with UpCloud’s infrastructure via our [verified provider module](/docs/guides/upcloud-terraform-provider.md). Using the UpCloud Terraform provider is as simple as declaring the required providers in a configuration file and then adding the desired resources.

To begin with, you need to allow Terraform to access your UpCloud account by setting an account name and password in your environmental variables. If you haven’t done so already, check out our [Terraform intro guide](/docs/guides/get-started-terraform.md) to set your API credentials before continuing with the rest of this guide.

## Setting up a configuration directory

Managing cloud infrastructure using Terraform makes it simple to edit, review, and version, as well as easy to share amongst team members. This includes everything from Cloud Servers to Managed Databases.

If you have already set up your Terraform directory, feel free to skip to the next section.

First, create a directory to hold your Terraform configuration.

```
mkdir ~/terraform-upcloud-database && cd ~/terraform-upcloud-database
```

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
    }
  }
}

provider "upcloud" {
  # Your UpCloud credentials are read from the environment variables
  # export UPCLOUD_USERNAME="Username for Upcloud API user"
  # export UPCLOUD_PASSWORD="Password for Upcloud API user"
  # Optional configuration settings can be depclared here
}
```

Afterwards, save the file and exit the editor.

Then run the following command in that directory to download the necessary provider modules.

```
terraform init
```

With the required module declaration in place, you can get started.

Next, create a new Terraform configuration, for example, `db-example.tf` in your Terraform directory.

```
touch db-example.tf
```

Once done, you are good to continue.

## Create Managed Databases

The UpCloud Managed Database currently supports MySQL and PostgreSQL databases, each of which can be configured using Terraform as its own resource.

For example, MySQL configuration would look something like the following.

```
# MySQL managed database with additional logical database: example2_db
resource "upcloud_managed_database_mysql" "example" {
  name = "mymysql-1"
  plan = "1x1xCPU-2GB-25GB"
  zone = "nl-ams1"
}
```

As for the latter, PostgreSQL can be created with the example below.

```
# PostgreSQL managed database with additional logical database: example_db
resource "upcloud_managed_database_postgresql" "example" {
  name  = "postgres-1"
  plan  = "1x1xCPU-2GB-25GB"
  zone  = "nl-ams1"
}
```

Now, open the `db-example.tf` file in your favourite text editor. Then, include a resource section using one of the example configurations shown above.

Once you’ve added your Managed Database configuration, next you need to deploy it. Terraform offers easy-to-use commands to safely and predictably deploy resources and apply changes.

First, verify your build plan with the following command.

```
terraform plan
```

This generates an execution plan that shows what actions will be taken when the plan is applied. It includes the server configuration, log-in details, storage settings, and the deployment zone.

Next, deploy the configuration by executing the plan with the command below.

```
terraform apply
```

Reply `yes` when asked to confirm the deployment.

Terraform performs syntax verifications again in deployment to spare you from configuration errors that could take precious time to roll back.

Separating plans and applying commands reduces mistakes and uncertainty at scale. Plans show operators what would happen when executing changes with the apply command.

## MySQL custom configurations

Terraform allows you to easily create Managed Database instances with minimal configuration. However, it also provides options for further customisation using the `properties` options.

For example, when configuring MySQL, you can set many additional properties besides the minimal configuration.

```
# Service with custom properties
resource "upcloud_managed_database_mysql" "example_3" {
  name = "mysql-3"
  plan = "2x2xCPU-4GB-50GB"
  zone = "nl-ams1"
  properties {
    admin_username     = "admin"
    admin_password     = "{password}"
    backup_hour        = 1  # Backup at 1.30AM
    backup_minute      = 30
    ip_filter          = ["public_ip_1/32", "public_ip_range/24"]
    public_access      = true
    max_allowed_packet = 16e+6 # 16MB
    sort_buffer_size   = 4e+6 # 4MB
    sql_mode           = "NO_ENGINE_SUBSTITUTION"
    version            = "8"
    wait_timeout       = 300
  }
}
```

You can find a full list of configurable properties in the [module documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs/resources/managed_database_mysql).

## PostgreSQL custom configurations

Below is an example of some of the additional configuration `properties` for PostgreSQL.

```
# Service with custom properties
resource "upcloud_managed_database_postgresql" "example_2" {
  name  = "postgres-2"
  plan  = "2x2xCPU-4GB-50GB"
  title = "postgres"
  zone  = "nl-ams1"
  properties {
    admin_username = "admin"
    admin_password = "{password}"
    backup_hour    = 1
    backup_minute  = 30
    ip_filter      = ["public_ip_1/32", "public_ip_range/24"]
    public_access  = true
    version        = "13"
  }
}
```

Check out the full list of configurable properties in the [module documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs/resources/managed_database_postgresql).

## Creating logical databases

Besides creating Managed Database instances, Terraform is also able to create new databases within the system as needed.

For example, if you had a Managed Database instance configured like the configuration underneath.

```
# MySQL managed database with additional logical database: example2_db
resource "upcloud_managed_database_mysql" "example" {
  name = "mysql-1"
  plan = "1x1xCPU-2GB-25GB"
  zone = "nl-ams1"
}
```

You could then create databases using the upcloud\_managed\_database\_logical\_database resource by simply providing the target database service ID and giving the database a name.

```
resource "upcloud_managed_database_logical_database" "example2_db" {
  service = upcloud_managed_database_mysql.example.id
  name    = "example2_db"
}
```

When set, just run the Terraform apply command again to create the configured database.

Likewise, if you want to remove a database from the system, delete the relevant resource within your configuration files and apply the changes using Terraform.

## Adding database users

In addition to being able to create databases, Terraform can manage database users as well.

For example, to add a new username to any database, create the following resource and configure the target service database ID, username and password.

```
resource "upcloud_managed_database_postgresql" "example" {
  name  = "postgres"
  plan  = "1x1xCPU-2GB-25GB"
  title = "postgres"
  zone  = "nl-ams1"
}
```

```
resource "upcloud_managed_database_user" "example_user" {
  service  = upcloud_managed_database_postgresql.example.id
  username = "example_user"
  password = "{password}"
}
```

After making the changes to your Terraform configuration, run the apply command again. You can then connect to the database using the newly created credentials.

If you want to remove a username configured via Terraform, just delete the resource from your configuration file and apply the changes.

## Connecting to the Managed Database

Once you have created your Managed Database using Terraform, you would likely want to connect to it. To do so, you will need the right connection details on top of your username and password.

Check on Terraform for the database details using the following command.

```
terraform show
```

Find your service connection details. The output should show something similar to the example below.

```
resource "upcloud_managed_database_mysql" "example2_db" {
    ...
    plan                    = "1x1xCPU-2GB-25GB"
    powered                 = true
    primary_database        = "defaultdb"
    service_host            = "mysql-1-riweqdegodht.db.upclouddatabases.com"
    service_password        = (sensitive value)
    service_port            = "11550"
    service_uri             = (sensitive value)
    service_username        = "upadmin"
```

You can then use the service host, port, password and username to connect to your new Managed Database. The easiest way to test the connection is using a command-line client like `mycli`.

Install the client on your computer or Cloud Server.

```
# Ubuntu and Debian
sudo apt install mycli
# CentOS
sudo yum install mycli
```

Then test your database connection with the connection string.

```
mycli mysql://admin:{password}@mysql-1-riweqdegodht.db.upclouddatabases.com:11550/defaultdb?ssl-mode=REQUIRED
```

If you enabled public access, add public- to the beginning of your service host. For example:

```
mycli mysql://admin:{password}@public-mysql-1-riweqdegodht.db.upclouddatabases.com:11550/defaultdb?ssl-mode=REQUIRED
```

Should you need to use public access regularly, remember to restrict the accepted connections with the IP filtering in the database properties.

```
resource "upcloud_managed_database_mysql" "example2_db" {
  ...
  properties {
    ...
    ip_filter = ["public_ip_1/32", "public_ip_range/24"]
```

Replace the `public_ip/32` or `public_ip_range/24` with the actual public IP addresses of your external resources.

## Summary

Terraform is a powerful tool for building cloud infrastructure from Cloud Servers to Object Storage and Managed Databases. It codifies your systems for more efficient management and adds to the value of UpCloud’s Managed Databases by making them even easier and faster to configure.
