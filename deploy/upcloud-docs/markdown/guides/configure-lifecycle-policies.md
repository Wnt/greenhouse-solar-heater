# How to configure lifecycle policies

Enabling [object versioning](/docs/guides/enable-and-manage-s3-object-versioning.md) uses more storage space since multiple versions of objects are stored. To help manage storage usage when using versioning, you can implement lifecycle policies to automatically expire (delete) versions after a certain period.

This guide covers how to create and apply lifecycle policies to your buckets using two different tools: AWS CLI (which uses JSON format) and s3cmd (which uses XML format).

## Using AWS CLI

For AWS CLI Installation and setup, refer to our guide [Connecting to an UpCloud Object Storage instance using AWS CLI](/docs/guides/connecting-to-an-object-storage-instance.md)

**Note:** Starting with version 2.23.0, AWS CLI changed how it handles Content-MD5 headers for S3 operations. This causes a "Missing required header for this request: Content-MD5" error. If you're using a newer version, either downgrade to AWS CLI version 2.22.32 or earlier, or use the [s3cmd method](/docs/guides/configure-lifecycle-policies#using-s3cmd.md) below.

To create a lifecycle policy for a versioned bucket using AWS CLI, you need to create a JSON file that defines the lifecycle rules. Here's an example of a lifecycle policy JSON file (`lifecycle.json`) that expires non-current object versions after 30 days:

```
{
    "Rules": [
        {
            "ID": "DeleteOldVersions",
            "Status": "Enabled",
            "Prefix": "",
            "NoncurrentVersionExpiration": {
                "NoncurrentDays": 30
            }
        }
    ]
}
```

To apply this lifecycle policy to your versioned bucket, use the following command:

```
aws s3api put-bucket-lifecycle-configuration --bucket {bucket-name} --lifecycle-configuration file://{filepath-of-policy}

# Example:
aws s3api put-bucket-lifecycle-configuration --bucket my-bucket --lifecycle-configuration file://lifecycle_policy.json
```

You can confirm that the lifecycle policy has been applied by retrieving the bucket's lifecycle configuration:

```
aws s3api get-bucket-lifecycle-configuration --bucket {bucket-name}

# Example:
aws s3api get-bucket-lifecycle-configuration --bucket my-bucket

{
    "Rules": [
        {
            "ID": "DeleteOldVersions",
            "Prefix": "",
            "Status": "Enabled",
            "NoncurrentVersionExpiration": {
                "NoncurrentDays": 30
            }
        }
    ]
}
```

To remove a lifecycle policy if needed:

```
aws s3api delete-bucket-lifecycle --bucket {bucket-name}

# Example:
aws s3api delete-bucket-lifecycle --bucket my-bucket
```

## Using s3cmd

For s3cmd Installation and setup, refer to our guide [Connecting to an UpCloud Object Storage instance using s3cmd](/docs/guides/connecting-to-an-object-storage-instance-s3cmd.md)

When using s3cmd, lifecycle policies must be defined in XML format instead of JSON. Below is an example of a lifecycle policy XML file (`lifecycle.xml`) that expires non-current object versions after 30 days:

```
<?xml version="1.0" encoding="UTF-8"?>

<LifecycleConfiguration>
    <Rule>
        <ID>DeleteOldVersions</ID>
        <Status>Enabled</Status>
        <Prefix></Prefix>
        <NoncurrentVersionExpiration>
            <NoncurrentDays>30</NoncurrentDays>
        </NoncurrentVersionExpiration>
    </Rule>
</LifecycleConfiguration>
```

To apply this lifecycle policy to your versioned bucket:

```
s3cmd setlifecycle lifecycle.xml s3://{bucket-name}

# Example:
s3cmd setlifecycle lifecycle.xml s3://my-bucket
```

You can confirm that the policy has been applied:

```
s3cmd getlifecycle s3://{bucket-name}

# Example:
s3cmd getlifecycle s3://my-bucket
```

To remove a lifecycle policy if needed:

```
s3cmd dellifecycle s3://{bucket-name}

# Example:
s3cmd dellifecycle s3://my-bucket
```
