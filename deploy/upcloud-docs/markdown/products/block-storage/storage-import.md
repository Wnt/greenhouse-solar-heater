# Storage import

The Storage import service allows users to easily import installation media or entire virtual machine images to their UpCloud account. This enables users to quickly migrate servers from on-premise or any other cloud provider by importing the server image and attaching the created storage device to a Cloud Server.

![Storage import dialog on the control panel](storage-import.png)

Storage import is accessed on the control panel from Storage → Device → Add storage from URL.

Storage import creates a new storage device, and populates is with data from the URL.

The import service supports the following file formats:

- RAW storage images (extension .raw)
- IMG storage images (extension .img)
- ISO archive files (extension .iso)
- GZIP (extension .gz, content-type must be set to application/gzip)
- XZ (extension .xz, content-type must be set to application/x-xz)

Images in other formats must be converted before importing.

The system image or installation media being imported needs to be made available for download for the Storage Import service to be able to retrieve it. The process supports the use of HTTPS and HTTP Basic Auth for secure uploads.

### Additional resources

- Guide: [How to upload data using Storage Import](/docs/guides/storage-import.md)
- Guide: [Using your own install media](/docs/guides/using-own-install-media.md)
