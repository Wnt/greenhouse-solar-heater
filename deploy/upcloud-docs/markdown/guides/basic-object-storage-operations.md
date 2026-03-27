# How to perform basic Object Storage operations using AWS CLI

This guide covers the fundamental operations you can perform with UpCloud Object Storage using AWS CLI. You'll learn how to create and manage buckets, upload and download files, generate temporary access links, and perform basic cleanup operations.

## Prerequisites

Before beginning, make sure have [installed and configured AWS CLI](/docs/guides/connecting-to-an-object-storage-instance.md) for use with UpCloud Object Storage.

## Creating and managing buckets

### Create a bucket

Create a new storage bucket:

```
aws s3api create-bucket --bucket <bucket-name>
```

### List buckets

View all your buckets:

```
aws s3 ls                # simple list

aws s3api list-buckets   # detailed list in json format
```

### Delete a bucket

Remove an empty bucket:

```
aws s3api delete-bucket --bucket <bucket-name>
```

Note: The bucket must be empty before it can be deleted. See the [cleanup operations](/docs/guides/basic-object-storage-operations#cleanup-operations.md) section below for removing bucket contents.

## Working with objects

### Upload a file

Upload a local file to your bucket:

```
aws s3 cp <local-file> s3://<bucket-name>
```

### List bucket contents

View all objects within a bucket:

```
aws s3 ls s3://<bucket-name>                   # simple list

aws s3api list-objects --bucket <bucket-name>  # detailed list in json format
```

### Download a file

Download a file from your bucket to your local machine:

```
aws s3 cp s3://<bucket-name>/<file-name> <local-destination>
```

### Copy between buckets

Copy an object from one bucket to another:

```
aws s3 cp s3://<source-bucket>/<file-name> s3://<destination-bucket>
```

### Move files

Move (copy and delete) files between buckets:

```
aws s3 mv s3://<source-bucket>/<file-name> s3://<destination-bucket>
```

### Generate a pre-signed URL

Create a temporary access link to a specific file:

```
aws s3 presign s3://<bucket-name>/<file-name> --expires-in <seconds>
```

The pre-signed URL allows temporary access to an object without requiring credentials. For example, setting `--expires-in 300` creates a link that remains valid for 5 minutes. After this time, the link expires and can no longer be used to access the file.

This is particularly useful when you need to:

- Share files temporarily with users who don't have storage credentials
- Generate time-limited download links
- Provide temporary access to private files

Note: If you need permanent public access to files instead of temporary links, see our guide on [setting up a public read bucket](/docs/guides/set-up-a-public-read-bucket.md).

## Cleanup operations

### Delete a specific file

Remove a single file from a bucket:

```
aws s3 rm s3://<bucket-name>/<file-name>
```

### Empty a bucket

Remove all files from a bucket:

```
aws s3 rm s3://<bucket-name> --recursive
```

Warning: This command permanently deletes all objects in the bucket. Use with caution.
