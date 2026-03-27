# Connecting to an UpCloud Object Storage instance using S3cmd

UpCloud's Managed Object Storage is fully S3-compliant, allowing various S3 clients to connect and access the Object Storage. This guide focuses on [s3cmd](https://s3tools.org/s3cmd), a command-line tool for managing S3 and S3-compatible object storage services.

## Installing S3cmd

Linux (Debian/Ubuntu)

```
sudo apt-get install s3cmd
```

RHEL/CentOS

```
sudo dnf install s3cmd
```

macOS (using Homebrew):

```
brew install s3cmd
```

## Configuring S3cmd

After installing s3cmd, you need to configure it to work with your UpCloud Object Storage. The easiest way to do this is by running the interactive configuration wizard:

```
s3cmd --configure
```

The wizard will prompt you for the following information:

1. Access Key: Enter your UpCloud S3 access key
2. Secret Key: Enter your UpCloud S3 secret key
3. Default Region: You can leave this blank for UpCloud Object Storage
4. S3 Endpoint: Enter your UpCloud S3 endpoint (e.g. `https://abcd1.upcloudobjects.com`)
5. DNS-style bucket+hostname:port template: Use `%(bucket)s.<s3-endpoint>` (replace `endpoint` with your actual s3 endpoint)
6. Encryption password: Optional, set if you want to use GPG encryption
7. Path to GPG program: Optional, required only if using GPG encryption
8. Use HTTPS protocol: Yes
9. HTTP Proxy server name: Leave blank unless you're using a proxy

After entering these details, the wizard will ask:

Test access with supplied credentials? [Y/n]

It's recommended to enter 'Y' here to verify that your configuration is correct. The wizard will attempt to make a connection to your UpCloud Object Storage using the provided information. If successful, you'll see a message confirming that the test passed.

If the test fails, double-check your access key, secret key, and endpoint URL. You will need to run the configuration wizard again to correct any mistakes.

```
New settings:
  Access Key: AK12345678912345
  Secret Key: 6Uxfgdgfhfgh763563424wfdgdhdghs45GK6QZ
  Default Region: US
  S3 Endpoint: jifb2.upcloudobjects.com
  DNS-style bucket+hostname:port template for accessing a bucket: %(bucket)s.abcd1.upcloudobjects.com
  Encryption password:
  Path to GPG program: /usr/bin/gpg
  Use HTTPS protocol: True
  HTTP Proxy server name:
  HTTP Proxy server port: 0

Test access with supplied credentials? [Y/n] Y
Please wait, attempting to list all buckets...
Success. Your access key and secret key worked fine :-)

Now verifying that encryption works...
Not configured. Never mind.

Save settings? [y/N]
```

The wizard will then create a configuration file at `~/.s3cfg`.

For security, ensure the configuration file has restrictive permissions:

```
chmod 600 ~/.s3cfg
```

## Common S3cmd operations

### Creating and managing buckets

#### Create a bucket

Create a new storage bucket:

```
s3cmd mb s3://<bucket-name>
```

#### List buckets

View all your buckets:

```
s3cmd ls
```

#### Delete a bucket

Remove an empty bucket:

```
s3cmd rb s3://<bucket-name>
```

Note: The bucket must be empty before it can be deleted. See the [cleanup operations](/docs/guides/connecting-to-an-object-storage-instance-s3cmd#cleanup-operations.md) section below for removing bucket contents.

### Working with objects

#### Upload a file

Upload a local file to your bucket:

```
s3cmd put <local-file> s3://<bucket-name>
```

#### List bucket contents

View all objects within a bucket:

```
s3cmd ls s3://<bucket-name>               # simple list
s3cmd ls s3://<bucket-name> --list-md5    # detailed list including MD5 sums
```

#### Download a file

Download a file from your bucket to your local machine:

```
s3cmd get s3://<bucket-name>/<file-name> <local-destination>
```

#### Copy between buckets

Copy an object from one bucket to another:

```
s3cmd cp s3://<source-bucket>/<file-name> s3://<destination-bucket>
```

#### Move files

Move (copy and delete) files between buckets:

```
s3cmd mv s3://<source-bucket>/<file-name> s3://<destination-bucket>
```

### Cleanup operations

#### Delete a specific file

Remove a single file from a bucket:

```
s3cmd rm s3://<bucket-name>/<file-name>
```

#### Empty a bucket

Remove all files from a bucket:

```
s3cmd del s3://<bucket-name>/* --recursive
```

Warning: This command permanently deletes all objects in the bucket. Use with caution.

### Additional operations

#### Making objects publicly accessible

1. Set public read access for a specific file:

```
s3cmd setacl s3://<bucket-name>/<file-name> --acl-public
```

This command makes a single file publicly readable.

2. Set public read access for an entire bucket:

```
s3cmd setacl s3://<bucket-name> --acl-public
```

Setting a bucket to public does not automatically make existing files in the bucket public. It only affects files added to the bucket after the policy has been applied.

3. To make all existing objects in a bucket public:

```
s3cmd setacl s3://<bucket-name>/* --acl-public
```

This command applies the public ACL to all current objects in the bucket.

To remove public access, use the `--acl-private` flag instead of `--acl-public` in the above commands.

#### Checking ACL status

To verify the ACL of a specific object or bucket:

```
s3cmd info s3://<bucket-name>/<file-name>
```

or for a bucket:

```
s3cmd info s3://<bucket-name>
```

#### Sync directories

Sync a local directory with a bucket:

```
s3cmd sync /local/directory/ s3://<bucket-name>
```

## Using multiple profiles

S3cmd doesn't have built-in support for multiple profiles. However, you can achieve a similar result by using multiple configuration files. Here's how:

1. Create separate configuration files for each profile:

```
s3cmd --configure -c ~/.s3cfg_profile1
s3cmd --configure -c ~/.s3cfg_profile2
```

2. To use a specific profile, include the `-c` flag in your s3cmd commands:

```
s3cmd -c ~/.s3cfg_profile1 ls
s3cmd -c ~/.s3cfg_profile2 ls
```

You can create aliases or shell functions to make this more convenient:

```
alias s3cmd_profile1='s3cmd -c ~/.s3cfg_profile1'
alias s3cmd_profile2='s3cmd -c ~/.s3cfg_profile2'
```

Then use them like this:

```
s3cmd_profile1 ls
s3cmd_profile2 ls
```
