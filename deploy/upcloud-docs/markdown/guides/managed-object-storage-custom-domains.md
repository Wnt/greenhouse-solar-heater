# How to configure Custom Domains for Managed Object Storage

UpCloud's Managed Object Storage service by default provides endpoints in the format **XYZ.upcloudobjects.com**. While functional, these default endpoints may not align with your branding or infrastructure naming conventions. Custom domains allow you to serve your stored objects from your own domain (e.g., **obj.example.com**), providing a more professional and branded experience for your users.

## Prerequisites

- An existing UpCloud Managed Object Storage instance.
- A domain name with access to DNS settings.
- Note: A subdomain is required - you cannot use your root domain as the storage endpoint. For example, use **storage.yourdomain.com** instead of **yourdomain.com**

### Important Considerations

1. DNS propagation typically takes 30-60 minutes.
2. After successful ACME challenge verifications, HTTPS becomes available.
3. Some Top-Level Domains (TLDs) with more than 7 characters may have limitations.

## Setup Instructions

1. Navigate to the [UpCloud Dashboard](https://hub.upcloud.com/object-storage/2.0)
2. Select your Managed Object Storage instance.
3. On the Overview page, scroll down to the **Custom domains** section.

![Custom domains](1-managed-object-storage-custom-domains.png)

4. Click the **Edit custom domains** button.
5. Enter your custom domain, and click **Add**.

![Add a new custom domain](2-managed-object-storage-add-custom-domain.png)

This will assign you 3 CNAME records to add to your domain. This is required to point your domain towards the correct object storage endpoint. It is also required for the SSL/TLS certificate.

## Configure DNS Records

1. Add the following CNAME records to your domain through your registrar. UpCloud does not currently provide DNS services, so you'll need to use your existing DNS provider. These records include an SSL challenge record, the main domain record, and a wildcard subdomain record.

   For more information about DNS concepts and configuration, see the [UpCloud DNS Guide](https://upcloud.com/blog/domain-name-system/).

| Host | Type | Data |
| --- | --- | --- |
| \_acme-challenge.obj | CNAME | \_acme-challenge.[unique-id].upcloudlb.com |
| obj | CNAME | [storage-id].upcloudobjects.com |
| \*.obj | CNAME | [storage-id].upcloudobjects.com |

2. Wait until the DNS records propagate (typically 30-60 minutes). This can sometimes take up to 24 hours in rare instances.
3. Verify propagation using **nslookup**, **dig**, or online DNS tools.
4. Return to the **custom domains** settings, and check the verification box.

![Create CNAME records](3-managed-object-storage-create-cname-records.png)

5. Click **Save**.

Once this has finished setting up, your object storage will return to the Running state.

**Note:** If the status remains "Pending" for more than 10 minutes, DNS propagation may not be complete or misconfigured, preventing SSL certificate verification.

You will see your new, custom endpoints here:

![Custom domain endpoints](4-managed-object-storage-custom-domain-endpoints.png)

## Testing and Validation

Verify that the endpoint works by curling an object using your newly created, custom domain endpoint.

1. Create a simple test file to verify your setup.

```
echo "Hello from obj.example.com" > test.txt
```

2. Create a new bucket called ***example***.

```
aws s3api create-bucket --bucket example --profile upcloud
```

3. Upload the test file to the bucket.

```
aws s3 cp test.txt s3://example --profile=upcloud
```

4. Make the object publicly readable. This will work for individual files even without a bucket policy.

```
aws s3api put-object-acl --bucket example --key test.txt --acl public-read --profile=upcloud
```

Alternatively, you may [configure a bucket policy](/docs/guides/set-up-a-public-read-bucket.md) to allow public access to all objects (files) in this bucket.

**Note:** This policy enables public read access to **ALL** objects in the bucket.

5. Verify the setup by accessing your test file.

```
curl https://obj.example.com/example/test.txt
Hello from obj.example.com
```

If successful, you will see your test message. If not, proceed to the Troubleshooting section.

## Cleanup

When you're done testing, clean up your resources. The bucket policy and object ACL will be automatically removed when we delete the bucket and object respectively - we don't need separate commands to remove them.

Remove the object from the managed object storage (this also removes its ACL).

```
aws s3 rm s3://example/test.txt --profile=upcloud
```

Remove the bucket (this also removes its policy).

```
aws s3 rb s3://example --profile=upcloud
```

Remove the local file.

```
rm example.txt
```

**Note:** The bucket deletion will fail if the bucket isn't empty. If necessary use this command to remove all objects from the **example** bucket.

```
aws s3 rm s3://example --recursive --profile=upcloud
```

## Troubleshooting Issues

Common issues and their solutions:

1. Pending State Persists on the Managed Object Storage.
   - If not already used, verify DNS propagation using multiple DNS lookup tools. You may need to wait for longer for propagation (up to 24 hours in rare cases).
   - Check your CNAME records to ensure they are accurate.
2. SSL Certificate Issues.
   - Ensure that the **\_acme-challenge** CNAME is correct.
   - Verify DNS propagation specifically for the challenge record.
   - Check for typos in record names.
   - Remove the domain from custom domains, and add it back. This will trigger a new challenge request. The CNAME records will remain identical.
3. Bucket or Object Access Denied Errors.
   - Verify that the bucket policy is correctly configured.

```
aws s3api get-bucket-policy --bucket example --profile upcloud
```

- Check the object ACL settings.

```
aws s3api get-object-acl --bucket example --key test.txt --profile upcloud
```

- Ensure that the bucket name matches in all commands.

4. Custom Domain Not Resolving.
   - Verify that all three CNAME records are properly configured.
   - Check for correct subdomain usage.
   - Ensure no conflicting DNS records exist.
