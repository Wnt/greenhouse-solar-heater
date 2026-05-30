# How to use Managed Object Storage as an S3 state backend for Terraform

By default, [Terraform](https://upcloud.com/blog/upcloud-verified-terraform-provider/) and OpenTofu store the state of your infrastructure (`terraform.tfstate`) on the local filesystem. For shared configurations or CI/CD pipelines, where multiple operators or machines need to access the state, you'll want to store the state remotely instead.

This guide shows how to configure [UpCloud Managed Object Storage](/docs/products/managed-object-storage.md) as a remote state backend using Terraform's S3 backend.

If you haven't set up Terraform with UpCloud yet, start with our [How to get started with Terraform](/docs/guides/get-started-terraform.md) guide. You'll also need a Managed Object Storage instance with a bucket and access credentials - see [How to deploy Managed Object Storage using Terraform](/docs/guides/deploy-managed-object-storage-terraform.md) or the [Managed Object Storage product documentation](/docs/products/managed-object-storage.md) for setup instructions.

S3 backend compatibility

The S3 backend's support for non-AWS S3 implementations is not tested by the OpenTofu or Terraform teams, so issues can arise when these tools adapt to new functionality in AWS S3. As an alternative, you can also use a [UpCloud Managed PostgreSQL database](https://developer.hashicorp.com/terraform/language/backend/pg) as the backend.

## Backend configuration

Add a `backend "s3"` block to your `terraform` configuration. The example below configures the backend against a Managed Object Storage instance - replace the bucket name, key, region, and endpoints with values matching your own instance.

```
terraform {
  # Other configuration, such as required_providers, omitted.

  backend "s3" {
    # Define the name of your bucket and the key for the state file.
    bucket = "example-bucket"
    key    = "example.tfstate"

    # Skip AWS-specific checks and use path-style URLs for
    # UpCloud Managed Object Storage.
    skip_requesting_account_id  = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    use_path_style              = true

    # Set the region to match your Managed Object Storage instance.
    region = "europe-1"

    # Configure the endpoints for your Managed Object Storage instance.
    endpoints = {
      s3  = "https://example.upcloudobjects.com"
      iam = "https://example.upcloudobjects.com:4443/iam"
      sts = "https://example.upcloudobjects.com:4443/sts"
    }

    # Credentials can be defined either in configuration or with
    # AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment
    # variables.
  }
}
```

The `skip_*` options and `use_path_style = true` are required because the S3 backend would otherwise try to validate the configuration against AWS-specific endpoints and services that don't exist in Managed Object Storage.

The `region` value should match the region of your Managed Object Storage instance (for example `europe-1`). The `endpoints` map points the backend at your instance, and the `s3`, `iam`, and `sts` URLs are visible in the Managed Object Storage details in the UpCloud Control Panel.

For credentials, the access key and secret pair generated for your Managed Object Storage instance are passed in the same way as AWS credentials, for example, by using the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables.

After saving the configuration, run `terraform init` (or `tofu init`) to initialise the backend. Terraform will create the state object in your bucket on the next `apply`.

## Troubleshooting checksum errors

Some versions of OpenTofu and Terraform perform additional integrity checks on uploaded objects even when `skip_s3_checksum` is set to `true`. This is caused by changes to the default behaviour of the AWS Go SDK, and shows up as `XAmzContent*Mismatch` errors when the state is saved.

To disable these checks, set `request_checksum_calculation` and `response_checksum_validation` to `when_required`. This can be done via environment variables:

```
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

## Summary

With the S3 backend pointed at Managed Object Storage, your Terraform or OpenTofu state lives in a bucket you control on UpCloud, ready to be shared between operators or used from a CI/CD pipeline. From here you might want to look at [How to use Terraform variables](/docs/guides/terraform-variables.md) to keep credentials and other values out of your configuration files.
