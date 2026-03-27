# How to generate access keys for a user using the API

In the [previous guide](/docs/guides/create-user-for-object-storage-using-the-api.md), you created a user for your Object Storage instance. To enable this user to authenticate and interact with the storage programmatically, you need to generate access keys for them.

Access keys consist of an `access key ID` and a `secret access key`. The access key ID is used to identify the user, while the secret access key acts as a password for authentication. It's important to keep the secret access key confidential and never share it with anyone.

To generate access keys for the user you created earlier, you'll need the uuid of the Object Storage instance and the username of the user. Make sure to replace `{uuid}` in the API request below with the actual uuid of your Object Storage instance and `{username}` with the username you created.

```
POST https://api.upcloud.com/1.3/object-storage-2/{uuid}/users/{your-account-username}/access-keys
```

The response should confirm that the request was successful and that the credentials have been created. This time, make a note of the following details which you will need later when [applying user access policies](/docs/guides/applying-user-access-policies-using-the-api.md):

1. access\_key\_id
2. secret\_access\_key
