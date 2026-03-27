# How to deploy Managed Object Storage using Terraform

In this guide, we’ll go through the steps needed to deploy an UpCloud Managed Object Storage service using Terraform.

This guide assumes you are familiar with Terraform and have already set up your UpCloud credentials in your environmental variables. Please refer to our [getting started with Terraform guide](/docs/guides/get-started-terraform.md) if you need help with the initial setup and configuration.

## Set up a working directory

Start by creating a working directory for your Terraform project and move into it.

```
mkdir -p ~/terraform
cd ~/terraform
```

## Set up the UpCloud Terraform configuration block

Within your working directory, create a configuration block to define the required UpCloud settings:

```
nano versions.tf
```

```
terraform {
  required_providers {
    upcloud = {
      source = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }
}
```

Note: If you need to manage bucket-level policies or CORS rules, see the section [Managing bucket policies with the objsto provider](/docs/guides/deploy-managed-object-storage-terraform#working-with-bucket-policies.md) at the end of this guide.

Save the file and exit the editor.

Initialise Terraform in your working directory:

```
terraform init
```

This will download the required UpCloud provider and set up your working directory.

## Write the Managed Object Storage configuration

Next, write the configuration for the Managed Object Storage by declaring the resources in a Terraform configuration file.

```
nano managed-object-storage.tf
```

The configuration will define:

- A Managed Object Storage service
- Buckets within that storage
- A user with access permissions
- Access credentials for the user
- Output blocks for:
  - Public endpoint
  - Any buckets created
  - User credentials

```
# Define your bucket names
variable "bucket_names" {
  type        = set(string)
  description = "Names of buckets to be created"
  default     = [
    "<BUCKET-NAME-1>",     # Replace with your first bucket name
    "<BUCKET-NAME-2>",     # Replace with your second bucket name
    "<BUCKET-NAME-3>"      # Replace with your third bucket name
  ]
}

# Create the managed object storage service
resource "upcloud_managed_object_storage" "terraform_storage" {
  name   = "<STORAGE-NAME>"
  region = "<REGION>"
  configured_status = "started"

  # Public access
  network {
    family = "IPv4"
    name   = "<PUBLIC-NETWORK-NAME>"
    type   = "public"
  }

  # Private access (optional)
  network {
    family = "IPv4"
    name   = "<PRIVATE-NETWORK-NAME>"
    type   = "private"
    uuid   = "<PRIVATE-NETWORK-UUID>" # The private network must already exist
  }

  # Optional label
  labels = {
    managed-by = "terraform"
  }

}

# Create buckets within the storage service
resource "upcloud_managed_object_storage_bucket" "terraform_bucket" {
  for_each     = var.bucket_names
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  name         = each.value
}

# Create a user for the storage service
resource "upcloud_managed_object_storage_user" "user" {
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  username     = "<USERNAME>"
}

# Create access credentials for the storage user
resource "upcloud_managed_object_storage_user_access_key" "user_key" {
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  username     = upcloud_managed_object_storage_user.user.username
  status       = "Active"
}

# Attach access policy to the storage user
resource "upcloud_managed_object_storage_user_policy" "user_policy" {
  username     = upcloud_managed_object_storage_user.user.username
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  name         = "<POLICY>"
}

# Output the public access endpoints
output "public_endpoints" {
  value = {
    endpoint = upcloud_managed_object_storage.terraform_storage.endpoint
  }
}

# Output all buckets created
output "all_buckets" {
  value = {
    for k, v in upcloud_managed_object_storage_bucket.terraform_bucket : k => {
      name = v.name
      id   = v.id
    }
  }
}

# Output the user access credentials (hidden by default)
output "access_credentials" {
  sensitive = true
  value = {
    access_key_id     = upcloud_managed_object_storage_user_access_key.user_key.access_key_id
    secret_access_key = upcloud_managed_object_storage_user_access_key.user_key.secret_access_key
  }
}
```

Before saving the configuration above, replace the placeholders with your own values:

- `<STORAGE-NAME>` - Name for your Managed Object Storage service
- `<PUBLIC-NETWORK-NAME>` - Name for your public network
- `<BUCKET-NAME>` - Name for your bucket(s)
- `<USERNAME>` - Username for your user

For the `<REGION>`, choose one of:

- `apac-1`
- `europe-1`
- `europe-2`
- `us-1`

For more details about region locations and their SDN accessibility, see our [availability page](/docs/products/managed-object-storage/availability.md).

For `<POLICY>`, choose from one of:

- `ECSS3FullAccess` - Full access to all buckets
- `ECSS3ReadOnlyAccess` - Read-only access to all buckets
- `IAMFullAccess` - Full IAM management
- `IAMReadOnlyAccess` - Read-only IAM access
- `ECSDenyAll` - Denies all access

You can also create custom policies with specific permissions - see the [Creating and attaching a custom user policy](/docs/guides/deploy-managed-object-storage-terraform#creating-and-attaching-a-custom-user-policy.md) section later in this guide.

For private network access (optional):

- `<PRIVATE-NETWORK-NAME>` - Name for your private network
- `<PRIVATE-NETWORK-UUID>` - UUID of your existing private network. It must be in the same availability zone as the Managed Object Storage region. To deploy with a new private network instead, see the section of the guide titled [Deploying with a new private network](/docs/guides/deploy-managed-object-storage-terraform#optional-deploying-with-a-new-private-network.md).

To deploy without private network access, remove the entire "Private access" network block from the configuration.

## (Optional) Deploying with a new private network

In the previous section we saw how to deploy a managed object storage attached to an existing private network.

To deploy a new Managed Object Storage service with a new (non existing) private network, first create a new router and new network, then attach the network to your new object storage service. Here's the modified configuration for that:

```
nano managed-object-storage.tf
```

```
# Create router for the private network
resource "upcloud_router" "storage_router" {
  name = "<ROUTER-NAME>"
}

# Create private network
resource "upcloud_network" "storage_network" {
  name = "<PRIVATE-NETWORK-NAME>"
  zone = "<ZONE>"

  ip_network {
    address = "<NETWORK-ADDRESS>"
    dhcp    = true
    family  = "IPv4"
  }

  router = upcloud_router.storage_router.id
}

# Create the managed object storage service
resource "upcloud_managed_object_storage" "terraform_storage" {
  name              = "<STORAGE-NAME>"
  region            = "<REGION>"
  configured_status = "started"

  # Public access
  network {
    family = "IPv4"
    name   = "<PUBLIC-NETWORK-NAME>"
    type   = "public"
  }

  # Private access
  network {
    family = "IPv4"
    name   = "<PRIVATE-NETWORK-NAME>"
    type   = "private"
    uuid   = upcloud_network.storage_network.id
  }
}

# Add the same bucket, user, policy, and output configurations as shown in the previous section
```

Replace the placeholders with your own values:

- `<ROUTER-NAME>` - Name for your new router
- `<PRIVATE-NETWORK-NAME>` - Name for your private network
- `<NETWORK-ADDRESS>` - Private network address range (e.g., "172.16.2.0/24")

For `<ZONE>`, use a corresponding zone for your chosen object storage region:

| Region | ZONE |
| --- | --- |
| apac-1 | sg-sin1, au-syd1 |
| europe-1 | dk-cph1, de-fra1, es-mad1, fi-hel1, fi-hel2, nl-ams1, no-svg1, pl-waw1, se-sto1, uk-lon1 |
| europe-2 | dk-cph1, de-fra1, es-mad1, fi-hel1, fi-hel2, nl-ams1, no-svg1, pl-waw1, se-sto1, uk-lon1 |
| us-1 | us-chi1, us-nyc1, us-sjo1 |

The rest of the placeholders remain the same as in the previous configuration.

## Plan and apply the infrastructure

Run Terraform `plan` to preview the changes:

```
terraform plan
```

You'll see an output showing what will be deployed. If you're happy with it, run the `apply` command:

```
terraform apply
```

Type **yes** when asked to confirm the deployment. This will begin deploying the resources described in the configuration file on your UpCloud account.

The process may take a while, but when it completes, Terraform will display:

- The storage endpoint
- Access credentials for your user (marked as sensitive)

You can view the sensitive credentials by running the following output command:

```
terraform output access_credentials
```

To see your storage endpoint, run:

```
terraform output public_endpoints
```

Once you have your storage service running and credentials ready, you might want to test it out. Check out our guide on [Connecting to an UpCloud Object Storage instance using S3cmd](/docs/guides/connecting-to-an-object-storage-instance-s3cmd.md) to learn how to upload and manage files in your new storage service using the S3cmd command-line tool.

## Modifying the infrastructure

### Add additional buckets

To add more buckets, simply add new bucket names to the `bucket_names` variable in your configuration:

```
# Define your bucket names
variable "bucket_names" {
  type        = set(string)
  description = "Names of buckets to be created"
  default     = [
    "<BUCKET-NAME-1>",     # Replace with your first bucket name
    "<BUCKET-NAME-2>",     # Replace with your second bucket name
    "<BUCKET-NAME-3>",     # Replace with your third bucket name
    "<BUCKET-NAME-4>"      # Add more bucket names as needed
  ]
}
```

### Add more users

Add new users and their access credentials:

```
# Create a second user
resource "upcloud_managed_object_storage_user" "second_user" {
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  username     = "<USERNAME-2>"
}

# Create access credentials for the second user
resource "upcloud_managed_object_storage_user_access_key" "second_user_key" {
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  username     = upcloud_managed_object_storage_user.second_user.username
  status       = "Active"
}

# Attach access policy to the second user
resource "upcloud_managed_object_storage_user_policy" "second_user_policy" {
  username     = upcloud_managed_object_storage_user.second_user.username
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  name         = "<POLICY>"
}
```

After adding these resources, run `terraform plan` followed by `terraform apply` to deploy the additional resources.

## Creating and attaching a custom user policy

To use a custom policy with specific permissions instead of the predefined ones like `ECSS3FullAccess`, add the following custom policy to your existing configuration:

```
# Create a custom policy
resource "upcloud_managed_object_storage_policy" "custom_policy" {
    name         = "<CUSTOM-POLICY-NAME>"
    description  = "<CUSTOM-POLICY-DESCRIPTION>"
    service_uuid = upcloud_managed_object_storage.terraform_storage.id
    document     = urlencode(file("<CUSTOM-POLICY-DOCUMENT>"))   # path to json file
}
```

Then, update your policy attachment block to use the custom policy:

```
# Attach access policy to the storage user
resource "upcloud_managed_object_storage_user_policy" "user_policy" {
    username     = upcloud_managed_object_storage_user.user.username
    service_uuid = upcloud_managed_object_storage.terraform_storage.id
    name         = "<CUSTOM-POLICY-NAME>"
}
```

Replace these placeholders:

- `<CUSTOM-POLICY-NAME>` - Name for your custom policy
- `<CUSTOM-POLICY-DESCRIPTION>` - Brief description of what the custom policy does
- `<CUSTOM-POLICY-DOCUMENT>` - The path to your custom JSON policy document

## Remove resources

To remove resources, delete their configuration blocks from the file and run `terraform plan` followed by `terraform apply`. Terraform will identify the resources to be destroyed and remove them when you confirm the apply.

For example, to remove a bucket, modify the bucket\_names variable by removing or commenting out the bucket name:

```
# Define your bucket names
variable "bucket_names" {
  type        = set(string)
  description = "Names of buckets to be created"
  default     = [
    "<BUCKET-NAME-1>",
    "<BUCKET-NAME-2>",
    #"<BUCKET-NAME-3>"     # REMOVE OR COMMENT THIS LINE TO DELETE THIS BUCKET
  ]
}
```

To remove a user, you'll need to delete all three associated resource blocks: the user configuration, access key, and policy attachment. For example:

```
# Delete all these blocks to remove the user
resource "upcloud_managed_object_storage_user" "user" {
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  username     = "<USERNAME>"
}

resource "upcloud_managed_object_storage_user_access_key" "user_key" {
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  username     = upcloud_managed_object_storage_user.user.username
  status       = "Active"
}

resource "upcloud_managed_object_storage_user_policy" "user_policy" {
  username     = upcloud_managed_object_storage_user.user.username
  service_uuid = upcloud_managed_object_storage.terraform_storage.id
  name         = "<POLICY>"
}
```

Note: The `upcloud_managed_object_storage_bucket` resource uses the UpCloud API to manage Managed Object Storage buckets. The main difference to S3 API is that the buckets can be deleted even when the bucket contains objects.

The plan will show which resources will be destroyed. Review it carefully before confirming the apply.

If you want to remove **all** resources and completely tear down the infrastructure, you can use:

```
terraform destroy
```

This command will remove all resources defined in your Terraform configuration. Use it with caution as it will delete everything, including all buckets, users, and the storage service itself. Terraform will show you a plan of what will be destroyed and ask for confirmation before proceeding.

## Working with bucket policies

While the `upcloud` provider allows us to create and manage the infrastructure for Managed Object Storage, it currently does not support configuring bucket-level policies.

To manage bucket policies we need to use the `objsto` provider.

The `objsto` provider is developed by UpCloud specifically for managing S3-compatible object storage services using the S3 API.

By using both providers ([`upcloud`](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest) and [`objsto`](https://registry.terraform.io/providers/UpCloudLtd/objsto/latest)) together, we get complete control over our object storage setup.

After deploying your Managed Object Storage with the UpCloud provider, let's see how to use the `objsto` provider to manage bucket-level policies and configurations.

### Update the provider configuration

First, update your `versions.tf` file to include both providers:

```
terraform {
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
    objsto = {
      source  = "UpCloudLtd/objsto"
      version = "~> 0.1"
    }
  }
}
```

### Example bucket configurations

Next, create one of these JSON policy document files based on your requirements:

#### Allow public read access

This policy allows public read access to your bucket and its contents. Create a file named `public-read-policy.json`:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Principal": {
        "AWS": ["*"]
      },
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::<BUCKET-NAME>"
      ]
    },
    {
      "Principal": {
        "AWS": ["*"]
      },
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::<BUCKET-NAME>/*"
      ]
    }
  ]
}
```

#### Configure CORS rules

This policy sets up Cross-Origin Resource Sharing rules for your bucket. Create a file named `cors-rules.json`:

```
{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "HEAD", "DELETE", "PUT", "POST"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["x-amz-server-side-encryption"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

#### Configure bucket lifecycle

This policy sets up automatic object expiration rules. Create a file named `lifecycle-rules.json`:

```
{
  "Rules": [
    {
      "Id": "Expire old versions",
      "Status": "Enabled",
      "Filter": {
        "Prefix": ""
      },
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 7
      }
    },
    {
      "Id": "Expire objects with status tag",
      "Status": "Enabled",
      "Filter": {
        "Tag": {
          "Key": "status",
          "Value": "completed"
        }
      },
      "Expiration": {
        "Date": "2024-01-01T00:00:00Z"
      }
    }
  ]
}
```

### Create bucket policies configuration

After creating your chosen JSON policy file, you'll need to configure the bucket policies with your storage service details. Before proceeding, make sure you have the following information ready:

- Your object storage endpoint
- Your bucket name
- Your access and secret keys

You can get these details by running:

```
terraform output public_endpoints
terraform output all_buckets
terraform output access_credentials
```

Now, create `bucket-policies.tf` and add the `objsto` provider configuration using these credentials and endpoint:

```
nano bucket-policies.tf
```

```
provider "objsto" {
  endpoint   = "https://<YOUR-ENDPOINT>"
  region     = "<REGION>"
  access_key = "<ACCESS-KEY>"
  secret_key = "<SECRET-KEY>"
}

resource "objsto_bucket_policy" "<BUCKET-POLICY-NAME>" {
  bucket = "<BUCKET-NAME>"
  policy = file("<BUCKET-POLICY>")  # path to policy json file
}
```

Replace the placeholders:

- `<YOUR-ENDPOINT>` - Your object storage service endpoint
- `<REGION>` - The region where your storage is deployed (e.g., europe-1, us-1, apac-1)
- `<ACCESS-KEY>` - Access key from your storage user
- `<SECRET-KEY>` - Secret key from your storage user
- `<BUCKET-POLICY-NAME>` - A name for the bucket policy
- `<BUCKET-NAME>` - Name of your bucket
- `<BUCKET-POLICY>` - The path to your JSON policy document. See the section above for [examples](/docs/guides/deploy-managed-object-storage-terraform#example-bucket-configurations.md)

### Apply the configuration

After updating the files, initialise Terraform with the new provider and apply the changes:

```
terraform init
terraform plan
terraform apply
```
