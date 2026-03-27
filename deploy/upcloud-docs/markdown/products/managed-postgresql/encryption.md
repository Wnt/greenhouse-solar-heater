# Encryption for Managed PostgreSQL

Data-at-rest encryption covers both active service instances and backups stored in cloud object storage.

For service instances, full-volume encryption is implemented using LUKS with a unique ephemeral key generated for each instance and volume. These keys are never reused and are securely disposed of when the instance is terminated, ensuring automatic key rotation during upgrades. The default LUKS2 mode utilized is aes-xts-plain64:sha256 with a 512-bit key.

Backups are encrypted using a distinct key for each file. These keys are further encrypted using an RSA key-encryption key pair stored in the header section of each backup segment. AES-256 in CTR mode is employed for file encryption, and HMAC-SHA256 is used for integrity protection. Each service is assigned a randomly generated RSA key pair, with key lengths set at 256 bits for block encryption, 512 bits for integrity protection, and 3072 bits for the RSA key.

PostgreSQL is a registered trademark of the PostgreSQL Community Association of Canada, and used with their permission.
