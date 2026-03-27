# How to configure CORS policy on a bucket

When building web applications that interact with files in your object storage bucket, you may encounter CORS (Cross-Origin Resource Sharing) errors. These occur because web browsers, by default, prevent JavaScript from accessing resources hosted on different domains - a security feature that protects users from malicious websites.

This guide shows you how to configure a CORS policy on your bucket to allow specific web applications to access your files. You might need this when building applications that upload files directly to your bucket, display images from your bucket dynamically, or process stored files using JavaScript.

## Prerequisites

Before beginning, make sure you have [installed and configured AWS CLI](/docs/guides/connecting-to-an-object-storage-instance.md) for use with UpCloud Managed Object Storage.

## Creating a CORS configuration

To enable CORS on a bucket, you'll need to apply a CORS configuration. This is done in two steps:

1. Create a CORS configuration file
2. Apply the configuration to your bucket

First, create a CORS configuration file using the commands below:

Linux / MacOS (terminal)

```
touch cors.json
nano cors.json
```

Windows (command prompt)

```
type nul > cors.json
notepad cors.json
```

When the editor opens, add the following content:

```
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
      "MaxAgeSeconds": 3000,
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"]
    }
  ]
}
```

Note: Using `["*"]` in `AllowedOrigins` allows access from any domain. For production environments, you should specify exact domains in the `AllowedOrigins` array (e.g., `["https://yourdomain.com"]`) for better security.

Similarly, using `["*"]` in `AllowedHeaders` permits all headers - in production, you might want to specify only the headers your application needs.

Then, apply the CORS configuration to your bucket:

```
aws s3api put-bucket-cors --bucket <bucket-name> --cors-configuration file://cors.json
```

Make sure to replace `<bucket-name>` with the name of your bucket.

## Security considerations

When configuring CORS for production use, you should implement the following security practices:

1. Specify exact domains in `AllowedOrigins` instead of using the wildcard `"*"`:

```
"AllowedOrigins": ["https://yourdomain.com", "https://admin.yourdomain.com"]
```

2. Only include the HTTP methods that your application needs. For example, if your application only reads files, limit the methods to:

```
"AllowedMethods": ["GET", "HEAD"]
```

3. Specify the exact headers your application uses rather than allowing all headers with `["*"]`:

```
"AllowedHeaders": [
    "Content-Type",
    "Authorization",
    "If-Match",
    "If-None-Match"
]
```

4. Consider combining CORS with [bucket policies](/docs/guides/set-up-a-public-read-bucket.md) for proper access control

## Viewing current CORS configuration

You can view the current CORS configuration of your bucket using:

```
aws s3api get-bucket-cors --bucket <bucket-name>
```

## Removing CORS configuration

If you need to remove the CORS configuration, use:

```
aws s3api delete-bucket-cors --bucket <bucket-name>
```

This removes the CORS configuration entirely. Once removed, web browsers will block JavaScript requests to your bucket from different domains.
