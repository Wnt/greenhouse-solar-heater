# Rolling Update for UpCloud Servers Using Terraform and Ansible

This tutorial demonstrates how to perform a rolling update for an application on a set of UpCloud servers. The process involves:

- Using Terraform to provision and manage the infrastructure on UpCloud.
- Employing Ansible to configure and update NGINX web servers on these instances.
- Implementing a rolling update strategy to modify the web content without downtime.
- Utilizing a load balancer to distribute traffic among the servers during the update process.

The rolling update allows you to change the web content (in this case, an animal-themed static page) across all servers gradually, ensuring continuous service availability.

## Prerequisites

Install the required tools:

- Terraform
- Ansible
- `upcloud-ansible-collection` and UpCloud Python SDK (upcloud-api>=2.5.0)
- Git client

Follow these tutorials if you are unfamiliar with setting up these tools:

- [How to get started with Terraform](/docs/guides/get-started-terraform.md)
- [How to get started with Ansible Inventory](/docs/guides/get-started-ansible-inventory.md)

Example material used in this guide is available from the UpCloud Ansible Collection repository in Github. Clone the repository for further steps:

```
git clone https://github.com/UpCloudLtd/upcloud-ansible-collection.git
```

## Setup

1. Set UpCloud credentials by using `upctl account login` command or with environment variables:

   ```
   # Use API token...
   export UPCLOUD_TOKEN="ucat_..."

   # ...or username and password
   export UPCLOUD_USERNAME="your-username"
   export UPCLOUD_PASSWORD="your-password"
   ```
2. Enter the example directory and create a set of UpCloud servers:

   ```
   cd upcloud-ansible-collection/examples/inventory-rolling-update/resources
   terraform init
   terraform apply
   cd ..
   ```
3. Install and configure NGINX on the servers created in the previous step:

   ```
   # Initial configuration
   ansible-playbook configure-webserver.yml --extra-vars "serial_override=0"

   # Update with specific tag
   ansible-playbook configure-webserver.yml --extra-vars "animal=tiger"
   ```
4. Monitor updates:

   ```
   watch -n 0.75 curl -s $(terraform -chdir=resources output -raw lb_url)
   ```
5. Cleanup:

   ```
   terraform -chdir=resources destroy
   ```
