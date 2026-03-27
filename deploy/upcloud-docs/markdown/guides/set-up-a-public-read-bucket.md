# How to set up a public read bucket

**By default your bucket and all the objects (files) inside it are private**. This means they are only accessible to authorised users. While [pre-signed URLS](/docs/guides/basic-object-storage-operations#generate-a-pre-signed-url.md) are useful for securely sharing individual objects temporarily, they aren't ideal for long-term sharing needs. For use cases that require broader public access (also known as anonymous access), a public read bucket is a better approach. A public read bucket allows anyone to view or download files within it while maintaining restrictions on modifications and deletions.

This guide demonstrates how to configure a bucket that allows public read access to all its objects - both existing ones and any files added later. This is a common requirement for hosting website assets like images and videos that need to be publicly accessible but protected from unauthorised changes.

## Prerequisites

Before beginning, make sure have [installed and configured AWS CLI](/docs/guides/connecting-to-an-object-storage-instance.md) for use with UpCloud Object Storage.

## Creating a bucket

If you don't already have a bucket you want to make public, you can create one using the following command:

```
aws s3api create-bucket --bucket <bucket-name>
```

Replace `<bucket-name>` with your chosen bucket name. Note: If you've set up multiple profiles, you can add the –profile= flag to specify which profile to use.

## Configuring public access

To make a bucket publicly readable, you'll need to apply a specific bucket policy. This is done in two steps:

1. Create a policy file
2. Apply the policy to your bucket

First, create a policy file using the commands below:

Linux / MacOS (terminal)

```
touch public-read-policy.json
nano public-read-policy.json
```

Windows (command prompt)

```
type nul > public-read-policy.json
notepad public-read-policy.json
```

When the editor opens, add the following content:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadForNewObjects",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<bucket-name>/*"
    }
  ]
}
```

Make sure to replace `<bucket-name>` with your actual bucket name.

Note: The Sid (Statement ID) field is optional but helpful for identifying specific policy statements when troubleshooting or reviewing logs.

Then, apply the policy to your bucket:

```
aws s3api put-bucket-policy --bucket <bucket-name> --policy file://public-read-policy.json
```

Make sure to replace `<bucket-name>` with the name of your bucket.

## Testing the configuration

To test your public read bucket, you can upload a file and then access it through its public URL:

1. Upload a test file:

```
aws s3 cp <local-file> s3://<bucket-name>
```

Replace `<local-file>` with the path to your file and `<bucket-name>` with your bucket name.

Alternatively, you can use an [S3-compatible client](/docs/guides/get-started-managed-object-storage#file-management-clients.md) like Cyberduck to upload files through a graphical interface.

2. Access the file using one of these URL formats:

- `https://<endpoint>/<bucket-name>/<object>`
- `https://<bucket-name>.<endpoint>/<object>`

For example:

`https://jifb2.upcloudobjects.com/publicread/bucket.jpg`
`https://publicread.jifb2.upcloudobjects.com/bucket.jpg`

The file should be accessible through a web browser without requiring authentication.

## Security considerations

When using public read buckets, keep in mind:

- All objects in the bucket will be readable by anyone on the internet who knows the URL
- The bucket policy only allows reading objects (GetObject permission)
- Write operations (upload, modify, delete) still require proper authentication
- Consider using [pre-signed URLS](/docs/guides/basic-object-storage-operations#generate-a-pre-signed-url.md) instead if you only need to share specific files temporarily

## Removing public access

If you later decide to make the bucket private again, you can easily remove the bucket policy using this command:

```
aws s3api delete-bucket-policy --bucket <bucket-name>
```

This removes ALL bucket policies, not just the public read policy. Once removed, the bucket and its objects will return to their default private statee and only accessible to authorised users. If you have other bucket policies that you want to keep, you should modify the policy document rather than deleting it entirely.
