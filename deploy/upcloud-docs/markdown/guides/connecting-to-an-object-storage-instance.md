# Connecting to an UpCloud Object Storage instance using AWS CLI

UpCloud's Managed Object Storage is fully S3-compliant, meaning any existing S3 client is able to connect to and access the Object Storage. This includes [AWS CLI](https://aws.amazon.com/cli/), which allows you to manage files on UpCloud’s Object Storage as seamlessly as you would on Amazon's S3 service.

Instructions for installing AWS CLI on Linux, MacOS, and Windows can be found on the [AWS documentations page.](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.md)

## Configuration

After you've installed AWS CLI you'll need to create two files:

- a configuration file to store your endpoint details
- a credentials file to store your access keys

If they do not already exist, you can create them using the commands below:

Linux / MacOS (terminal)

```
mkdir -p ~/.aws
touch ~/.aws/config
touch ~/.aws/credentials
```

Windows (command prompt)

```
mkdir "%UserProfile%\.aws"                     # Creates the .aws directory in your user profile
type nul > "%UserProfile%\.aws\config"         # Creates an empty config file
type nul > "%UserProfile%\.aws\credentials"    # Creates an empty credentials file
```

On Linux/MacOS, for security purposes, it's recommended to set restrictive permissions on these files since they will contain sensitive credentials. This ensures only your user account can read or modify them:

```
chmod 600 ~/.aws/credentials
chmod 600 ~/.aws/config
```

Next, open the configuration file in an editor.

Linux / MacOS

```
nano ~/.aws/config
```

Windows

```
notepad "%UserProfile%\.aws\config"
```

and add the following content:

```
[default]
endpoint_url = https://abcd1.upcloudobjects.com
```

Make sure to replace the endpoint url with your actual UpCloud S3 endpoint url.
Save the file and exit the editor.

Then open the credentials file in an editor.

Linux / MacOS

```
nano ~/.aws/credentials
```

Windows

```
notepad "%UserProfile%\.aws\credentials"
```

and add the following content:

```
[default]
aws_access_key_id = AKIA[REDACTED]A04
aws_secret_access_key = 6Ua2bG8d[REDACTED]Im7GK6QZ
```

Make sure to replace the access key id and secret access key with your actual UpCloud S3 credentials.
Save the file and exit the editor.

## Testing the connection

To confirm that the connection works we can run a command that list all the buckets in our Object Storage.

This command should run successfully if AWS CLI is configured correctly - even if the Object Storage has no buckets yet.

```
aws s3 ls
```

You will see one of these responses:

1. An empty response (no output) - This is normal if you don't have any buckets yet. It means AWS CLI successfully connected to your storage but found no buckets to list.
2. A list of bucket names - This means AWS CLI successfully connected and found existing buckets in your storage.
3. An error message - This usually indicates a configuration problem:

   - "Could not connect to the endpoint URL" suggests your endpoint\_url might be wrong
   - "Unable to locate credentials" means there's an issue with your credentials file
   - "Invalid credential" means your access keys might be incorrect
   - "InvalidAccessKeyId" could mean either your access key is incorrect OR your endpoint\_url is wrong

## Using multiple profiles

If you need to connect to multiple Object Storage instances, you can create additional profiles. In your config file, add a new profile just beneath the existing default profile:

```
[default]
endpoint_url = https://abcd1.upcloudobjects.com

[profile storage2]
endpoint_url = https://efgh2.upcloudobjects.com
```

And in your credentials file:

```
[default]
aws_access_key_id = AKIA[REDACTED]A04
aws_secret_access_key = 6Ua2bG8d[REDACTED]Im7GK6QZ

[storage2]
aws_access_key_id = BKIA[REDACTED]B05
aws_secret_access_key = 7Va3cH9e[REDACTED]Jn8HL7RZ
```

To use your additional profile, add the `--profile` flag to your commands:

```
aws s3 ls --profile storage2
```

You can name your profile anything you want (like "backup", "testing", or "production") - just make sure to use the same profile name in both the config and credentials files.

Note that you don't need to specify the `--profile` flag when using the default profile.

## Next steps

Now that you've configured AWS CLI for your Object Storage, you can learn more about managing your storage with our other guides:

- [How to perform basic Object Storage operations](/docs/guides/basic-object-storage-operations.md)
- [How to set up a public read bucket](/docs/guides/set-up-a-public-read-bucket.md)
- [How to enable and manage S3 object versioning](/docs/guides/enable-and-manage-s3-object-versioning.md)
- [How to configure lifecycle policies](/docs/guides/configure-lifecycle-policies.md)
