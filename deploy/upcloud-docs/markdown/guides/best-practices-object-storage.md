# Best practices for UpCloud Managed Object Storage

UpCloud Managed Object Storage is an S3-compatible storage service built for large-scale unstructured data. It works well out of the box, but how you structure your data, configure your tools, and manage your requests can make a big difference to performance and cost.

This guide covers practical recommendations based on common patterns we see across customer workloads. You don't need to read it end to end - you can simply jump to the sections most relevant to your use case.

## Private endpoints

If your application and Object Storage instance are in the same region, it is recommended to use the private S3 endpoint instead of the public one. Private endpoints route traffic through UpCloud's SDN private network rather than the public internet, which provides two benefits:

- **Better performance.** Internal routing is more direct and avoids the shared public load balancer frontends. You'll see lower latency and more consistent throughput, especially for high-volume workloads.
- **No impact on your fair transfer limit.** Traffic over private endpoints does not count towards your account's [fair transfer limit](https://upcloud.com/fair-transfer-policy/), making it more cost-effective for large data transfers between your servers and Object Storage.

To use a private endpoint, attach an SDN private network to your Object Storage instance. You can do this during creation or afterwards through the UpCloud Control Panel or API. Once attached, you'll receive private endpoints for S3, IAM, and STS that are accessible only from servers on that private network.

Private endpoints follow the same format as public ones but include `-private` in the hostname, for example: `mud5q-private.upcloudobjects.com`. Access control rules work identically regardless of which endpoint you use.

For more details on configuring private access, see the [getting started guide](/docs/guides/get-started-managed-object-storage.md).

## Object sizes

Object storage is designed for storing and retrieving reasonably sized objects. Every request carries some overhead - authentication, routing, metadata handling - and that overhead becomes noticeable when objects are very small.

**Aim for objects in the 1 to 100 MiB range where practical.** This is where the overhead of each request is small compared to the actual data being transferred, so you get the best throughput.

If your workload produces many small files (under 1 MiB), consider combining them before uploading. For example:

- **Compress and archive** small files into `.tar.gz` or `.zip` bundles on the client side before upload.
- **Batch log entries** into periodic uploads (e.g. every 10 minutes) rather than uploading individual log lines continuously.
- **Combine assets** where possible - a single archive of configuration files is more efficient than hundreds of individual uploads.

The maximum supported object size is 5 TB (using multipart upload).

## Choosing the right workload

Object storage is optimised for storing and retrieving complete objects - files that are written once and read many times, or replaced entirely when updated. It is not a general-purpose filesystem or database.

**Avoid frequent small updates to the same objects.** Every write in object storage replaces the entire object, even if only a single byte has changed. Workloads that make frequent, small updates - like databases, message queues, or transactional systems - are a poor fit. They create a high volume of requests while moving very little data, which puts unnecessary strain on the storage backend.

If your workload involves any of the following, object storage is likely not the right tool:

- Frequent reads and writes to small records (database-like access)
- Low-latency random access to many small files
- Workloads that need strong consistency guarantees
- Running applications directly on an S3-mounted filesystem (databases, mail servers, CI build directories)

For these use cases, consider [block storage](/docs/products/block-storage.md) for single-server workloads, [Managed Databases](https://upcloud.com/products/managed-databases/) for structured data, or [File Storage (NFS)
- [/docs/products/file-storage.md) for shared filesystem access across multiple servers.

Object storage is at its best for backups and archival, media and asset storage, log aggregation, static website hosting, and large-scale data distribution - workloads where data is written in bulk and read on demand.

## Multipart uploads

For objects larger than 100 MiB, use multipart upload instead of a single PUT request. Multipart upload splits a large file into smaller parts that are uploaded independently and then assembled on the server side.

This gives you several advantages:

- **Parallel transfer.** Multiple parts can be uploaded simultaneously, making better use of available bandwidth.
- **Resilient uploads.** If a part fails, only that part needs to be retried rather than the entire file.
- **Reduced failure impact.** A network interruption during a 5 GB single-part upload means starting over. With multipart, you only lose the part that was in flight.

The maximum part size is 5 GiB. The best part size depends on the size of the object you're uploading. For objects around 100 MB, part sizes of 8 to 16 MB work well. For objects around 1 GB or larger, 32 to 64 MB is a good starting point. AWS CLI defaults to 8 MB, which is fine for most workloads, but increasing it for larger objects can improve throughput.

Most S3 clients handle multipart uploads automatically above a configurable threshold. For AWS CLI, you can tune this in your AWS config file:

```
# ~/.aws/config
[default]
s3 =
  multipart_threshold = 100MB
  multipart_chunksize = 64MB
```

## Client-side parallelism

More concurrent connections generally means better throughput. Most S3 clients use conservative defaults that don't make the most of your available bandwidth.

Start by increasing the number of concurrent transfers in your client configuration. A range of 10 to 30 simultaneous connections is a reasonable starting point, with higher values being more beneficial when transferring many smaller files. The AWS CLI default is 10.

```
# ~/.aws/config
[default]
s3 =
  max_concurrent_requests = 20
```

For s3cmd, the `--parallel` flag or `parallel_uploads` configuration option controls this.

**Scale up gradually.** While more parallelism helps, sudden spikes of very large numbers of simultaneous requests can cause increased latencies. If you're running a workload that sends a lot of requests at the same time, consider increasing the number gradually instead of sending thousands of requests all at once.

If you're transferring large numbers of files, combining increased parallelism with multipart uploads for individual large files gives the best results.

## LIST operations

Listing large numbers of objects can be slow and resource-intensive, especially on buckets with millions of objects.

**Avoid listing entire buckets when you don't need to.** If you know the key (path) of the object you need, fetch it directly with a GET request. Many applications use LIST operations unnecessarily when a direct GET would work.

When you do need to list objects:

- **Use a prefix** to narrow the scope. Listing objects under `logs/2025/03/` is much faster and less resource-intensive than listing an entire bucket.
- **Paginate results.** The maximum page size is 1,000 objects per request, which works well for most use cases. If you're experiencing timeouts on large buckets, try lowering the page size to 100-500. If you're listing all objects in a bucket regardless, keep the page size at 1,000 as larger batches are more efficient overall.
- **Cache listing results** on the client side if your application needs to reference the same list repeatedly.

Be especially careful with operations that trigger LIST calls under the hood. S3 `sync` commands, for example, list the entire source and destination before transferring anything. On a bucket with millions of objects, this can take a very long time and slow things down for your other operations.

If you're using `sync`, scope it with a prefix where possible:

```
# Instead of syncing the entire bucket
aws s3 sync s3://my-bucket ./local-dir

# Sync only what you need
aws s3 sync s3://my-bucket/logs/2025/03/ ./local-dir/logs/2025/03/
```

## Retry logic and backoff

Transient errors are normal in any distributed system. Your application should handle them gracefully with retries, but the way that you retry also matters.

**Use exponential backoff with jitter.** This means increasing the wait time between retries (e.g. 1s, 2s, 4s, 8s) and adding a small random delay to each wait. This stops multiple clients from retrying at the same time and flooding the backend.

Avoid aggressive retry loops with no backoff. A client that immediately retries hundreds of failed requests can make a temporary slowdown worse by adding more load.

Most S3 client libraries have configurable retry behaviour. For AWS CLI:

```
# ~/.aws/config
[default]
retry_mode = adaptive
max_attempts = 5
```

The `adaptive` retry mode in AWS CLI applies exponential backoff with jitter automatically. It also slows down requests if it detects throttling.

## Caching

If your application reads the same objects frequently, caching can reduce the number of requests hitting the storage backend.

- **Client-side caching.** Cache frequently accessed objects in local memory or on disk. This is especially effective for configuration files, templates, and other small objects that don't change often.
- **Reverse proxy caching.** Place a caching proxy (such as Nginx or Varnish) in front of your Object Storage endpoint to serve repeated requests from cache.
- **Set Cache-Control headers.** When uploading objects that will be served to end users (e.g. website assets, images), set appropriate `Cache-Control` metadata so downstream clients and proxies can cache them:

```
aws s3 cp ./assets/ s3://my-bucket/assets/ --recursive \
  --cache-control "max-age=86400"
```

This sets a 24-hour cache lifetime. Adjust the `max-age` value based on how frequently your content changes.

Caching is especially useful for read-heavy workloads and for small objects, where the overhead of each request makes up a larger share of the total cost.

## Bucket structure

How you organise your buckets affects performance, access control, and how easy your storage is to manage. There are no hard limits on the number of buckets you can create within an Object Storage instance, so use them to separate concerns.

**Separate buckets by workload type.** Different workloads often have different access patterns, retention requirements, and permission needs. For example:

- A `backups` bucket with lifecycle policies to auto-expire old data
- An `assets` bucket with public read access for serving website content
- A `logs` bucket with write-only access for your application servers

**Use key prefixes for logical organisation within a bucket.** Object storage doesn't have real directories, but you can use prefixes (e.g. `logs/2025/03/05/`) to organise objects in a way that makes listing and lifecycle rules more efficient.

**Isolate workloads from different clients or tenants.** If you're a reseller or running multi-tenant infrastructure, put each client's data in a separate bucket. Each bucket has its own internal processing queue, so a single client running an aggressive workload - millions of LIST requests, rapid-fire small writes, or large sync operations - can cause increased latencies for everyone else sharing the same bucket.

This also makes access control simpler: you can assign per-tenant IAM users with policies scoped to their specific bucket, rather than managing complex prefix-based permissions within a shared bucket.

For large deployments, consider using separate Object Storage instances for your heaviest users to provide even stronger isolation.

**Use a consistent naming convention.** Bucket names must be unique within an Object Storage instance. A naming scheme like `{project}-{environment}-{purpose}` (e.g. `webapp-prod-assets`, `webapp-staging-logs`) makes it easier to manage buckets at scale.

## Lifecycle policies

Lifecycle policies automate the cleanup of objects you no longer need, keeping storage costs under control and preventing unchecked growth.

Common use cases for lifecycle policies:

- **Expire old backup versions.** If you have versioning enabled, lifecycle policies can automatically delete non-current versions after a set number of days.
- **Clean up temporary data.** Uploaded processing artifacts, build outputs, or staging data can be set to expire automatically.
- **Remove incomplete multipart uploads.** Failed or abandoned multipart uploads leave behind orphaned parts that still consume storage. A lifecycle rule can clean these up automatically.

Here's an example lifecycle policy that expires non-current object versions after 30 days and cleans up incomplete multipart uploads after 7 days:

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
        },
        {
            "ID": "CleanupIncompleteUploads",
            "Status": "Enabled",
            "Prefix": "",
            "AbortIncompleteMultipartUpload": {
                "DaysAfterInitiation": 7
            }
        }
    ]
}
```

Apply it using AWS CLI:

```
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration file://lifecycle.json
```

For detailed instructions on creating lifecycle policies with both AWS CLI and s3cmd, see our [lifecycle policies guide](/docs/guides/configure-lifecycle-policies.md).

## Versioning

S3 versioning protects your data against accidental overwrites and deletions by keeping a full history of every object. When enabled, each upload creates a new version instead of replacing the existing object.

Versioning is valuable for important data, but it comes with a trade-off: every version consumes storage space. Without lifecycle policies to expire old versions, storage usage will grow indefinitely.

**Always pair versioning with lifecycle policies.** Decide how many days of history you need and configure a lifecycle rule to expire older versions automatically. For most workloads, 7 to 30 days of version history is enough.

To enable versioning on a bucket:

```
aws s3api put-bucket-versioning \
  --bucket my-bucket \
  --versioning-configuration Status=Enabled
```

For detailed instructions, see our [versioning guide](/docs/guides/enable-and-manage-s3-object-versioning.md).

## Access control and IAM

UpCloud Managed Object Storage supports fine-grained access control through IAM users, groups, roles, and policies. Setting this up properly protects your data and limits the damage if credentials are leaked.

**Follow least privilege.** Give each user or application only the permissions it needs. A backup agent that writes to a single bucket doesn't need full access to all buckets. Use the built-in policies (`ECSS3FullAccess`, `ECSS3ReadOnlyAccess`) as a starting point, and create custom policies when you need finer control.

**Use separate users for separate applications.** Each application should have its own user with its own access keys. This makes it easier to rotate credentials and revoke access without affecting other services.

**Rotate access keys regularly.** Each user can have up to two active access keys at a time. Use this to rotate keys without downtime: create a new key, update your application, then deactivate the old key.

**Use roles and STS for temporary access.** If an application only needs access for a short period - for example, a nightly backup job - use IAM roles with the STS endpoint to issue time-limited credentials. This is more secure than embedding permanent access keys in your application code.

**Never embed credentials in source code.** Use environment variables, configuration files with restricted permissions, or a secrets manager.

For more on managing users and policies, see our guides on [creating users and applying access policies](/docs/guides/get-started-managed-object-storage#connecting-to-the-s3-api.md).

## Peak hours and scheduling

Object Storage infrastructure is shared across customers. During common backup windows - especially around midnight to 2:00 AM in European time zones - overall system load increases and you may experience higher latencies.

Where possible, schedule your heavy workloads (large backups, bulk migrations, batch processing) outside these peak windows. If you can't avoid running during peak hours, consider:

- **Staggering start times.** Instead of starting all backup jobs at exactly midnight, spread them across a wider window (e.g. 10 PM to 4 AM).
- **Using incremental backups.** Transferring only changed data rather than a full backup every time reduces the volume of requests during busy periods.
- **Rate-limiting client-side requests.** Deliberately throttling your upload rate during peak hours reduces your chance of hitting congestion-related timeouts.

## Use-case recommendations

### Backups and archival

Backup workloads tend to involve large volumes of data written in periodic bursts. You can optimise them by:

- **Compressing and archiving before upload.** Millions of individual small files are far less efficient than a smaller number of compressed archives. Tools like `tar`, `gzip`, or `zstd` can greatly reduce both object count and total size.
- **Staggering backup schedules** as described above to avoid peak congestion.
- **Using lifecycle policies** to auto-expire old backups. Define a retention period that meets your needs and let the lifecycle policy handle cleanup.
- **Separating backup workloads into dedicated buckets.** This isolates them from your production read/write traffic and makes it easier to apply specific retention policies.
- **Using multipart upload** for large backup archives to improve reliability and upload speed.

### Log storage

Collecting and storing logs involves many small writes over time, which is the opposite of what object storage is optimised for. You can improve performance by:

- **Batching log uploads.** Instead of uploading individual log entries or files as they're generated, buffer them locally and upload in batches at regular intervals (e.g. every 5 to 10 minutes).
- **Compressing logs before upload.** Gzipped log files are smaller and fewer in number, reducing both storage costs and request volume.
- **Using a structured key prefix** like `logs/{service}/{year}/{month}/{day}/` to make listing and retrieval efficient.
- **Setting lifecycle policies** to auto-expire logs after your required retention period.

### Static websites

UpCloud supports hosting static websites directly from Object Storage. For best results:

- **Set `Cache-Control` headers on your assets.** Objects are served without cache headers by default. Adding appropriate `max-age` values when uploading improves load times for returning visitors.

```
# Upload with a 24-hour cache lifetime
aws s3 sync ./build s3://my-bucket --cache-control "max-age=86400"
```

- **Deploy incrementally.** Instead of deleting and re-uploading all files on every update, upload only the files that have changed. This reduces the number of requests and avoids unnecessary LIST operations.
- **Configure CORS** if your website makes cross-origin requests to the storage endpoint. See our [CORS configuration guide](/docs/guides/configure-cors-policy-bucket.md) for instructions.

For a full walkthrough, see our [static website hosting guide](/docs/guides/host-static-website-object-storage.md).

### S3-mounted filesystems

Tools like `s3fs-fuse` and `rclone mount`, allow you to mount an S3 bucket as a local filesystem. This can be convenient, but object storage is not optimised for the access patterns of a traditional filesystem.

**This approach works best for read-heavy workloads with large files** - for example, serving media files or accessing large datasets that don't change frequently.

**Avoid running the following on S3-mounted filesystems:**

- Databases
- Mail servers
- CI/CD build directories
- Anything that makes frequent small reads and writes

These workloads generate large numbers of small operations that translate into API calls, each with its own latency overhead. Use [block storage](/docs/products/block-storage.md) or [File Storage (NFS)
- [/docs/products/file-storage.md) for these use cases instead.

If you do use an S3 mount, enable local caching to reduce the number of requests to the backend.

### Configuring CLI clients

Most S3-compatible CLI tools (AWS CLI, s3cmd, s4cmd) ship with conservative default settings. Tuning them for your workload can make a noticeable difference.

**AWS CLI recommended configuration:**

```
# ~/.aws/config
[default]
endpoint_url = https://your-endpoint.upcloudobjects.com
retry_mode = adaptive
max_attempts = 5
request_checksum_calculation = WHEN_REQUIRED
response_checksum_calculation = WHEN_REQUIRED

s3 =
  multipart_threshold = 100MB
  multipart_chunksize = 64MB
  max_concurrent_requests = 20
```

Note: The `request_checksum_calculation` and `response_checksum_calculation` lines are needed for AWS CLI versions 2.23.0 and above to avoid Content-MD5 header errors.

**s3cmd tips:**

- Increase parallel uploads with the `parallel_uploads` option in `~/.s3cfg`.
- Be careful with `s3cmd sync` on large buckets - it lists the entire bucket before starting the transfer. Use `--prefix` to narrow the scope where possible.
- Set `stop_on_error = False` to allow batch operations to continue past individual failures.

**General advice for all CLI tools:**

- Avoid recursive operations on very large directory trees. They generate massive LIST calls that can take a long time and impact performance.
- Scope `sync` operations to specific prefixes rather than syncing entire buckets.
- Test your configuration on a small dataset before running against production data.

## Presigned URLs

If you need to share an object with someone who doesn't have access keys, presigned URLs are a secure way to grant temporary access without opening up your bucket.

A presigned URL includes an expiry time, after which the link stops working. This is useful for sharing files with external users, generating download links in web applications, or providing temporary upload access.

Keep expiry times as short as practical for your use case. The S3 standard supports presigned URLs with expiry times of up to 7 days.

For usage examples, see our [basic Object Storage operations guide](/docs/guides/basic-object-storage-operations#generate-a-pre-signed-url.md).

## Monitoring usage

UpCloud provides usage metrics for your Object Storage instances, updated every 10 minutes. You can view these in the Usage tab of your Object Storage instance in the [UpCloud Control Panel](https://hub.upcloud.com/object-storage/2.0), or retrieve them programmatically via the [API](https://developers.upcloud.com/1.3/21-managed-object-storage/).

Available metrics include total storage size, total object count, and monthly cost. Storage and traffic statistics can be filtered by month and day.

Keep an eye on:

- **Storage growth over time.** If storage keeps growing without levelling off, lifecycle policies may be missing or misconfigured.
- **Object count.** A very high number of small objects relative to total storage size can indicate an inefficient upload pattern.
- **Request patterns.** If you're seeing increased latencies during specific windows, consider redistributing your workload schedule.

Regular monitoring helps you spot issues like rising storage costs or slowdowns before they become serious.
