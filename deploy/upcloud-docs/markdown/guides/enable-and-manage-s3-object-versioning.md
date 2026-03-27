# How to enable and manage S3 object versioning

S3 versioning is a feature that allows you to keep multiple versions of an object in the same S3 bucket. When versioning is enabled on a bucket, S3 automatically assigns a unique version ID to each object uploaded to the bucket. If you modify or overwrite an object, instead of replacing the existing object, S3 creates a new version of the object while preserving the previous versions.

To enable versioning on a bucket, use the command below:

```
aws s3api put-bucket-versioning --bucket={bucket-name} --versioning-configuration Status=Enabled --profile={profile}

aws s3api put-bucket-versioning --bucket=vertest --versioning-configuration Status=Enabled --profile=objectstorage-v2
```

You can confirm that it has been enabled by checking its status with the following command:

```
aws s3api get-bucket-versioning --bucket={bucket-name} --profile={profile}

aws s3api get-bucket-versioning --bucket=vertest --profile=objectstorage-v2

{
    "Status": "Enabled"
}
```

Now let's explore how versioning works in practice by performing a simple test. First, we'll upload a text file from our computer to our bucket. After that, we'll make some changes to the same file and upload it again, overwriting the old file.

Since versioning is enabled on the bucket, both versions of the file will be kept - the original version that was initially uploaded and the updated version that we uploaded afterwards.

1. Add some text to a new file called `test.txt`

```
echo "THIS TEXT IS OLD" > test.txt
```

2. Upload the file to a bucket with versioning enabled

```
aws s3 cp test.txt s3://vertest --profile=objectstorage-v2
```

3. Replace the old text with new text

```
echo "THIS TEXT IS NEW" > test.txt
```

4. Upload the modified file to the same bucket, overwriting the previous version:

```
aws s3 cp test.txt s3://vertest --profile=objectstorage-v2

upload: ./test.txt to s3://vertest/test.txt
```

5. List all the versions of the objects in the bucket using the following command:

```
aws s3api list-object-versions --bucket=vertest --profile=objectstorage-v2

{
    "Versions": [
        {
            "ETag": "\"e9d30e97bd058b821e5cc9dc1e6054b0\"",
            "Size": 17,
            "StorageClass": "STANDARD",
            "Key": "test.txt",
            "VersionId": "1711440852426",
            "IsLatest": true,
            "LastModified": "2024-03-26T08:14:12.426000+00:00",
            "Owner": {
                "DisplayName": "urn:ecs:iam::129c9eb1992744cfa4d1fd8c78826556:root",
                "ID": "urn:ecs:iam::129c9eb1992744cfa4d1fd8c78826556:root"
            }
        },
        {
            "ETag": "\"27e40fb25aba83c64f1e1ed49a201ee8\"",
            "Size": 17,
            "StorageClass": "STANDARD",
            "Key": "test.txt",
            "VersionId": "1711440837606",
            "IsLatest": false,
            "LastModified": "2024-03-26T08:13:57.606000+00:00",
            "Owner": {
                "DisplayName": "urn:ecs:iam::129c9eb1992744cfa4d1fd8c78826556:root",
                "ID": "urn:ecs:iam::129c9eb1992744cfa4d1fd8c78826556:root"
            }
        }
    ],
    "RequestCharged": null
}
```

To download a specific version of the file (object), use the command below:

```
aws s3api get-object --bucket {bucket-name} --profile={profile} --key {filename} --version-id {version-id} {local-file-path}

aws s3api get-object --bucket vertest --profile=objectstorage-v2 --key test.txt --version-id 1711440837606 test.txt.v1711440837606
```
