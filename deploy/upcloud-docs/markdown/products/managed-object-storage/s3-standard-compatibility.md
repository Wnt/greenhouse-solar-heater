# S3 standard compatible

UpCloud Managed Object Storage is fully compatible with the Amazon S3 API, ensuring that users can seamlessly integrate their existing S3-compatible applications and tools with UpCloud's Object Storage. This compatibility allows users to leverage the vast ecosystem of S3-compatible software and libraries, making it easy to migrate data and workflows.

Whether [migrating from another S3-compatible storage provider](/docs/guides/managed-object-storage-migration-tool.md) or building new applications, users can rely on UpCloud Managed Object Storage to deliver high performance, scalability, and compatibility.

## Supported S3 APIs

The following S3 features and API operations are fully supported in UpCloud Managed Object Storage:

- **Bucket operations:** CREATE, DELETE, GET, HEAD, PUT, LIST
- **Object operations:** DELETE, GET, HEAD, PUT, LIST, COPY, MULTIPART UPLOAD
- **Access control:** Bucket and Object ACLs, Bucket policies
- **Versioning:** Bucket versioning, Object versioning
- **Lifecycle management:** Bucket lifecycle policies
- **Cross-origin resource sharing (CORS):** Bucket CORS configuration
- **Object lock (Coming soon):** Bucket Object Lock configuration

Detailed instructions on how to use these features can be found in our [Object Storage guides section](/docs/guides/managed-object-storage.md).

## Advanced functionality

In addition to the standard S3 API features listed above, UpCloud Managed Object Storage supports the following advanced functionality:

- **Presigned URLs**: Users can generate presigned URLs to provide temporary access to objects, enabling secure sharing and distribution of data without compromising security. For more information on how to use this feature, refer to our guide on managing [Object Storage](/docs/guides/basic-object-storage-operations#generate-a-pre-signed-url.md).
- **Chunked PUT**: UpCloud Managed Object Storage supports chunked PUT operations, allowing users to upload large objects in smaller parts. This feature enhances upload reliability and enables resuming interrupted uploads.
- **Identity and Access Management (IAM)**: Users can control access to their buckets and objects using IAM policies. This allows for fine-grained access control and enables users to grant specific permissions to different users or applications. Refer to our guide on [IAM policies](/docs/guides/applying-user-access-policies-using-the-api.md) for more information on how to use this feature.

## Unsupported S3 APIs

The following S3 features and API operations are not supported in UpCloud Managed Object Storage:

| Feature | Unsupported API |
| --- | --- |
| Bucket Analytics | DeleteBucketAnalyticsConfiguration, GetBucketAnalyticsConfiguration, ListBucketAnalyticsConfigurations, PutBucketAnalyticsConfiguration |
| Bucket Replication | PutBucketReplication, GetBucketReplication, DeleteBucketReplication |
| Bucket Encryption | DeleteBucketEncryption, GetBucketEncryption, PutBucketEncryption |
| Bucket Inventory | DeleteBucketInventoryConfiguration, GetBucketInventoryConfiguration, ListBucketInventoryConfigurations, PutBucketInventoryConfiguration |
| Bucket Metrics | DeleteBucketMetricsConfiguration, GetBucketMetricsConfiguration, ListBucketMetricsConfigurations, PutBucketMetricsConfiguration |
| Bucket Website | DeleteBucketWebsite, GetBucketWebsite, PutBucketWebsite |
| PublicAccessBlock | DeletePublicAccessBlock, GetPublicAccessBlock, PutPublicAccessBlock |
| Bucket Accelerate | GetBucketAccelerateConfiguration, PutBucketAccelerateConfiguration |
| Bucket Logging | GetBucketLogging, PutBucketLogging |
| Bucket Request Payment | GetBucketRequestPayment, PutBucketRequestPayment |
| Bucket Policy Status | GetBucketPolicyStatus |
| Object Torrent | GetObjectTorrent |
| Restore Object | RestoreObject |
| Object Content Select | SelectObjectContent |
| Object Legal Hold | SetObjectLegalHoldRequest, ObjectLockLegalHold, ObjectLockLegalHoldStatus, SetObjectLegalHoldResult, GetObjectLegalHoldRequest, GetObjectLegalHoldResult |
| Object Retention | SetObjectRetentionRequest, ObjectLockRetention, ObjectLockRetentionMode, SetObjectRetentionResult, GetObjectRetentionRequest, GetObjectRetentionResult |
