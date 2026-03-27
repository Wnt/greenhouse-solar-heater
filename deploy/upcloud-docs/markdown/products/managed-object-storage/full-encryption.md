# Full encryption

All data stored in UpCloud Object Storage is fully encrypted at rest using server-side encryption techniques that utilise the advanced AES-256 encryption algorithm. This is widely recognised as a secure standard for data protection.

By default, UpCloud manages the encryption keys on behalf of the customers, simplifying the process of securing data. This allows customers to benefit from robust encryption without the need to manage keys themselves.

The encryption process is transparent to the user and occurs automatically when data is uploaded to UpCloud Object Storage. This means that users can store and retrieve their data as usual, while the encryption and decryption processes happen seamlessly in the background.

While the encryption process adds a layer of security, it does result in a slight performance impact. On average, users can expect a performance penalty of approximately 10% on S3 Transactions Per Second (TPS) due to the additional computation required for managing encryption keys and the encryption process itself.
