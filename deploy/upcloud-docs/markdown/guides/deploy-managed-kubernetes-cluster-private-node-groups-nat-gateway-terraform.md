# Deploying Managed Kubernetes cluster with private node groups and NAT Gateway using Terraform

Managed Kubernetes easily automates the deployment, scaling, and management of container workloads but takes a couple of steps to deploy by itself. In a previous guide we saw how to simplify the process by [deploying a Managed Kubernetes cluster with Terraform](/docs/guides/deploy-managed-kubernetes-cluster-private-node-groups-nat-gateway-terraform#.md).

In this guide, we’ll explore how to use Terraform to deploy a Managed Kubernetes cluster with private node groups and NAT Gateway.

## Installing Terraform

First things first. If you haven’t used Terraform before, you will need to start by installing it. You can follow our [beginners’ guide](/docs/guides/get-started-terraform.md) to accomplish this and then come back and continue here.

You can also check out [the official UpCloud Terraform provider documentation](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest/docs) to learn more.

## Setting up Managed Kubernetes

Once you have Terraform installed and ready, start by creating a new directory on your own computer to house your Terraform configuration files. The actual location of this folder doesn’t matter so much as the only requirement is that only one Terraform configuration is saved in any specific directory.

### Terraform configuration structure

Next, you’ll need a starting point. Rather than having you copy and paste from our guide, we've provided a convenient [zip file](/docs/guides/deploy-managed-kubernetes-cluster-private-node-groups-nat-gateway-terraform/uks-private-nat-gateway-terraform.zip.md) that contains all the necessary files. Simply download the zip file to access the example files and begin following along with the guide.

The cluster configuration is organized into the following files:

- **main.tf**
  This defines the managed resources: `upcloud_kubernetes_cluster`, `upcloud_network`, `upcloud_router`, and `upcloud_gateway`
- **provider.tf**
  Includes the main terraform block and provider-specific configurations
- **variables.tf**
  These define the input variables used in the configuration, e.g. zone
- **outputs.tf**
  Output values provide information about our deployment when it’s ready, like the cluster ID

Make sure to update `provider.tf` with your UpCloud API credentials, and feel free to modify the other files as needed.

The official [documentation](https://registry.terraform.io/providers/hashicorp/kubernetes/latest/docs) covers additional information needed on how to use the provider and its resources.

## Provisioning

When you have the configuration files all set, you can begin by initializing the directory.

```
terraform init
```

Terraform will then download the required plugins. You should see an output similar to below.

```
Initializing the backend...

Initializing provider plugins...
- Finding latest version of hashicorp/local...
- Finding latest version of hashicorp/kubernetes...
- Finding upcloudltd/upcloud versions matching ">= 2.11.0"...
- Installing hashicorp/local v2.4.0...
- Installed hashicorp/local v2.4.0 (signed by HashiCorp)
- Installing hashicorp/kubernetes v2.22.0...
- Installed hashicorp/kubernetes v2.22.0 (signed by HashiCorp)
- Installing upcloudltd/upcloud v2.12.0...
- Installed upcloudltd/upcloud v2.12.0 (self-signed, key ID 60B4E1988F222907)

Partner and community providers are signed by their developers.
If you'd like to know more about provider signing, you can read about it here:
https://www.terraform.io/docs/cli/plugins/signing.md

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

Next, test that the configuration is ready to deploy by running the *terraform plan* command.

```
terraform plan
```

```
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the
following symbols:
  + create
 <- read (data resources)

Terraform will perform the following actions:

  # data.upcloud_kubernetes_cluster.example will be read during apply
  # (config refers to values not yet known)

...

Plan: 6 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  + cluster_id = (known after apply)
```

The above example output has been truncated for brevity.

Lastly, if the plan looks all correct and Terraform didn’t report any issues, go ahead and deploy the setup. Confirm the deployment by answering yes when prompted.

```
terraform apply
```

You will then see a confirmation of the configuration followed by the deployment process. Running apply will create a network, a router, a NAT gateway, a Managed Kubernetes cluster, and a Kubernetes namespace in the new cluster.

```
...

Plan: 6 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  + cluster_id = (known after apply)
upcloud_network.example: Creating...
upcloud_network.example: Creation complete after 2s [id=03e416f9-0812-48bb-b58b-cf4ac74161eb]
upcloud_kubernetes_cluster.example: Creating...
upcloud_kubernetes_cluster.example: Still creating... [10s elapsed]
...
upcloud_kubernetes_cluster.example: Creation complete after 6m57s [id=0d1f7c52-4910-4970-b150-a07dce8615e2]
data.upcloud_kubernetes_cluster.example: Reading...
upcloud_kubernetes_node_group.group: Creating...
data.upcloud_kubernetes_cluster.example: Read complete after 0s [id=0d1f7c52-4910-4970-b150-a07dce8615e2]
local_file.kubeconfig[0]: Creating...
local_file.kubeconfig[0]: Creation complete after 0s [id=68796076a5b3afcce490db2a9464019b94a662ad]
upcloud_kubernetes_node_group.group: Creation complete after 1s [id=0d1f7c52-4910-4970-b150-a07dce8615e2/medium]

Apply complete! Resources: 6 added, 0 changed, 0 destroyed.

Outputs:

cluster_id = "0d1f7c52-4910-4970-b150-a07dce8615e2"
```

That’s it! Your Managed Kubernetes cluster is now fully functional with a private node group and NAT gateway, ready to handle any workload.
