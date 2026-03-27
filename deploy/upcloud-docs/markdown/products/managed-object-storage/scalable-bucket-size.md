# Scalable bucket size

With scalable buckets, users can start with a storage capacity that fits their current requirements and seamlessly grow the storage as their needs evolve. The system automatically scales the storage plan in increments of 250 GB based on usage, ensuring that users always have enough space for their data without any interruptions or manual intervention. There is no limit to the size of the storage, allowing users to store as much data as they need. This scalable storage solution is particularly beneficial for use cases such as:

- Hosting and storing large volumes of images
- Storing backups and archives
- Streaming video content

The pricing model for scalable buckets is designed to be flexible and cost-effective. Users only pay for the storage they consume, with competitive per-GB pricing that scales with usage. This pay-as-you-grow approach ensures that users can scale their storage capacity without overprovisioning or paying for unused resources. Users can easily monitor their storage consumption and associated costs through the usage tab of the Object Storage instance in the [UpCloud Control Panel](https://hub.upcloud.com/object-storage/2.0).

![](img/image.png)

For detailed pricing information, please refer to our [Object Storage pricing page](https://upcloud.com/pricing/#managed-object-storage).

To optimise usage of the scalable bucket size feature, consider implementing the following best practices:

1. Enable S3 versioning: By enabling versioning for your buckets, you can protect your data against accidental deletions and easily recover previous versions of objects. Learn more about enabling versioning [here](/docs/guides/enable-and-manage-s3-object-versioning.md).
2. Implement lifecycle policies: If you have versioning enabled, creating lifecycle policies is recommended to manage the retention and expiration of object versions automatically. This helps optimise storage usage and costs. Read more about configuring lifecycle policies [here](/docs/guides/configure-lifecycle-policies.md).
