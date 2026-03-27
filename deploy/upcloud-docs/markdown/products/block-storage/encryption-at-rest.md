# Encryption at Rest

All block storage devices can be optionally encrypted at rest. Block storages include normal block storages, backups and custom images. Any block storage device can be encrypted, including the storage device holding the Cloud Server’s operating system.

Block storage encryption is fully transparent to the Cloud Server and requires no additional software to be installed or management of encryption keys on the server.

Encryption is available for all block storage tiers: [MaxIOPS®, Standard and Archive](/docs/products/block-storage/tiers.md).

Encryption is performed using Advanced Encryption Standard (AES) with 256-bit keys.

Encryption at Rest is offered free of charge.

## Encrypting a storage device

Encryption can be enabled whenever a storage is created. Encryption cannot be enabled after creation, but a new encrypted copy can be created from an unencrypted storage device with the clone operation. Encrypted storage cannot be used as a clone source to make non-encrypted storage.

![Encryption at Rest is enabled when creating a storage](storage-creation-encryption-at-rest.png)

Encryption is automatically inherited to all storage devices created from another storage device. Backups created from an encrypted storage device will be encrypted. Server storage created from an encrypted custom image will be encrypted.

Each storage device has a randomly generated encryption key, managed by UpCloud. The encryption keys themselves are stored encrypted.

## Performance impact

Storage performance may be reduced by approximately 10-20% with encryption enabled when compared to unencrypted storage of the same type and size. Encryption can also make server creation and cloning operations take longer. The increase in operation time is proportional to the source template or storage size.

MaxIOPS is a registered trademark of UpCloud Ltd.
