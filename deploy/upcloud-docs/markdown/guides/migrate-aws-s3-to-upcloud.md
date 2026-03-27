# Migrate AWS S3 to UpCloud's Managed Object Storage

This guide describes how to migrate your existing data from Amazon S3 to UpCloud's Managed Object Storage service.

There are two methods available for doing this:

1. Using the migration tool in the UpCloud Control Panel (Recommended)
2. Using the UpCloud API

## Method 1: UpCloud Control Panel

The UpCloud Control Panel provides a user-friendly migration tool that simplifies the process of transferring your data from AWS to UpCloud.

To begin, navigate to the [migration tool](https://hub.upcloud.com/object-storage/migrate) in the UpCloud Control Panel, and click "+ Create new migration".

Next, fill in the source details:

![migration-tool-source](migration-tool-source.png)

- **Source endpoint:** This is the AWS S3 public endpoint for the source object storage (where you are transferring your data from). It is usually in the format `https://s3.{region}.amazonaws.com`.

  You can find your bucket's region in the AWS S3 Console under the bucket's Properties tab.

  ![Finding bucket region in AWS S3 console properties](aws-s3-bucket-region.png)
- **Source credentials:** This is the AWS Access key and Secret key. If you need to create new access credentials, follow these steps in the AWS Management Console:

  - Sign in to [AWS Management Console](https://console.aws.amazon.com)
  - Search for "IAM" in the top search bar and click on it
  - In the left sidebar menu, click on "Users"
  - Click on the username (or create a new user if needed)
  - Click on the "Security credentials" tab
  - Scroll to "Access keys" section and click "Create access key"
  - When prompted for use case, select "Command Line Interface (CLI)" and click "Next"
  - IMPORTANT: Save your Access Key and Secret Access Key securely - you'll only see the Secret Access Key once

    ![Creating a new access key in AWS IAM console](aws-iam-access-key-creation.png)
  - To add the required S3 permissions, go to the User "Permissions" tab, click "Add permissions", and either attach `AmazonS3ReadOnlyAccess` or create a custom policy with minimum permissions (`s3:ListBucket` and `s3:GetObject`) for the buckets you want to migrate.

    ![Adding S3 read permissions to IAM user](aws-iam-s3-permissions.png)
- **Source bucket (optional):** If no bucket is specified, all buckets from the source will be copied to the target.

Then, configure the target settings:

![migration-tool-target](migration-tool-target.png)

- **Target endpoint:** Select an existing UpCloud Managed Object Storage instance from the dropdown.
- **Target credentials:** This is the Access key and Secret key for the UpCloud Managed Object Storage instance. You can also create new credentials by clicking "Generate migration secrets". This will create a user with full access to the object storage instance. Be sure to delete this user once the migration is finished.
- **Target bucket:** Choose a target bucket for your data by selecting an existing one from the dropdown menu, or typing a name to create a new one. If no target bucket is selected, all buckets will be copied to the root directory.

Click "Create" to start the migration.

### Checking the progress

You can track the progress of your migration jobs in the control panel. For each job, you'll see its current status and any issues that arise. To stop an ongoing migration while it's running, simply click the "Cancel" button in the action column.

![migration-tool-progress](migration-tool-progress.png)

## Method 2: UpCloud API

For users who prefer programmatic control or need to automate the process, the migration can also be performed using the UpCloud API.

To get started, you will need an UpCloud user account with API credentials. Instructions for creating this can be found in the [Getting started using the UpCloud API guide](/docs/guides/getting-started-upcloud-api.md).

You'll also need an API client, or a way to make API calls. You can use any API client that you're comfortable with, such as [Yaak](https://yaak.app/) or the [curl](https://linuxize.com/post/curl-rest-api/) command line tool.

The process involves creating copy jobs via the API to transfer data from your AWS S3 buckets to the target Managed Object Storage. The system handles the data transfer automatically while providing status updates and detailed progress information.

It's worth noting that the migration process is non-destructive, meaning any files or buckets that exist only in the destination will be left untouched. Your source data in AWS S3 remains unchanged throughout the migration process, so you can continue using your S3 buckets until the migration is complete and verified.

Before beginning the migration, you will need the following:

- **Source endpoint URL**. This is the public endpoint for your AWS S3 buckets. The endpoint URL follows the format `https://s3.{region}.amazonaws.com`.
- **Source credentials:** This is the AWS Access key and Secret key with sufficient permissions to read from your source S3 buckets. The required permissions are either the `AmazonS3ReadOnlyAccess` policy or a custom policy with `s3:ListBucket` and `s3:GetObject` permissions.

  For guidance on creating access credentials, refer to the [AWS access keys documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.md).

  For instructions on attaching permissions to your IAM user, see the [AWS permissions documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.md).
- **Target endpoint**. This is the S3 public access endpoint for the UpCloud Managed Object Storage. You can find your endpoint URL via the [API](https://developers.upcloud.com/1.3/21-managed-object-storage/#get-service-details)..
- **Target credentials**. This is the Access key and Secret key for the UpCloud Managed Object Storage. If you don't have this, you'll need to [generate new keys for your user](/docs/guides/generate-access-keys-for-user-using-the-api.md).

  It is also necessary to ensure that the user has [full permission to access all storage buckets](/docs/guides/applying-user-access-policies-using-the-api.md) in the Managed Object Storage.

### Creating a full migration job

To migrate all buckets in an object storage instance, create a POST request using the API call below:

```
POST https://api.upcloud.com/1.3/object-storage-2/jobs

{
    "type": "copy",
    "source": {
        "access_key_id": "<aws_access_key_id>",
        "secret_access_key": "<aws_secret_access_key>",
        "endpoint_url": "https://s3.<region>.amazonaws.com"
    },
    "target": {
        "access_key_id": "<upcloud_access_key>",
        "secret_access_key": "<upcloud_secret_key>",
        "endpoint_url": "<upcloud_endpoint>"
    }
}
```

Note that `<region>` in the source endpoint URL should be replaced with your AWS region (e.g., us-east-1, eu-west-1, etc.). Also, make sure to use AWS credentials with appropriate S3 read permissions and the correct region where your buckets are located.

In an API client, such as Insomnia, the call above will look like this:

![Example of full migration API call in Insomnia client](full-migration-api-call.png)

The returned response will include the operational status of the migration job as well as the UUID of the job. You will need to take note of UUID of the job to check on the progress of the migration later.

### Creating a selective migration job

The migration tool can also be used to migrate specific buckets. This can be done using the POST request below:

```
POST https://api.upcloud.com/1.3/object-storage-2/jobs

{
    "type": "copy",
    "source": {
        "access_key_id": "<aws_access_key_id>",
        "secret_access_key": "<aws_secret_access_key>",
        "endpoint_url": "https://s3.<region>.amazonaws.com",
        "bucket": "<aws-source-bucket-name>"
    },
    "target": {
        "access_key_id": "<upcloud_access_key>",
        "secret_access_key": "<upcloud_secret_key>",
        "endpoint_url": "<upcloud_endpoint>",
        "bucket": "<upcloud-target-bucket-name>"
    }
}
```

Note that `<aws-source-bucket-name>` should be the name of your existing AWS S3 bucket, and `<upcloud-target-bucket-name>` will be the name of the new bucket in UpCloud's Managed Object Storage. The target bucket will be created automatically if it doesn't exist. Remember to replace `<region>` in the source endpoint URL with your AWS region (e.g., us-east-1, eu-west-1, etc.).

The migration is non-destructive, meaning any files or buckets that exist only in the destination will be left untouched.

Here is how the call looks in an API client:

![Example of selective migration API call in Insomnia client](selective-migration-api-call.png)

Like before, the response will include details of the job inculding its status and the job UUID.

### Monitoring the progress of a migration

Every time you initiate a migration job, you'll receive a response containing the job UUID:

```
{
...
  "updated_at": "2024-10-30T05:31:44.21534Z",
  "uuid": "12dab7d5-12c5-4c31-a881-10917ba10e6a"
}
```

You can check on the status of a job using its job UUID in the following GET request:

```
GET https://api.upcloud.com/1.3/object-storage-2/jobs/{uuid}
```

![Checking migration job status using GET request in Insomnia](migration-status-check.png)

The response will include the state of the migration job, as well as other pieces of related information, such as the amount of data transferred and the duration of the operation.

Jobs progress through the following operational states:

- `pending` - The job has been queued for processing
- `configuring` - The job is going through initial setup. This can take between 1-2 minutes
- `running` - The migration is still running, and data is being transferred
- `completed` - The migration has finished successfully
- `failed` - An error occurred during the execution of the job. Check `output.error` in the job status response for more information
- `cancelled` - The job was manually terminated. See below for how to do this

### Cancelling an ongoing migration

If needed, you can cancel an existing migration job using the API call below:

```
DELETE https://api.upcloud.com/1.3/object-storage-2/jobs/{job-uuid}
```

## Post-migration

Once you've finished copying your data from AWS S3, take time to verify that everything has transferred correctly to UpCloud's Managed Object Storage. This includes checking:

- All buckets and objects are present
- File contents are identical
- Object metadata and tags have been preserved
- Folder structures are maintained

You'll also need to update any applications that use the AWS S3 endpoints to use the new UpCloud Managed Object Storage endpoint instead.

If everything works as expected, you can consider deleting the original AWS S3 buckets. However, it's usually good practice to keep for a little while after the migration - just in case you need to roll back or verify anything.
