# How to create a user for an Object Storage instance using the API

Now that you have successfully created an Object Storage instance, the next step is to create a user who will have access to this instance. This user will be able to manage objects within the storage, depending on the access policies applied to their account.

To create a user, you'll need the uuid of the Object Storage instance you created earlier. Make sure to replace `{uuid}` in the API request below with the actual uuid you noted down in the previous step.

```
POST https://api.upcloud.com/1.3/object-storage-2/{uuid}/users

{
    "username": "{your-chosen-username}"
}
```

For example, if your Object Storage instance has a uuid of `129c9eb1-9927-44cf-a4d1-fd8c78826556`, and you want to create a user named `my-user`, the API request would look like this:

```
POST https://api.upcloud.com/1.3/object-storage-2/129c9eb1-9927-44cf-a4d1-fd8c78826556/users

{
    "username": "my-user"
}
```

The API will return a response confirming the creation of the new user. The response will include details such as the user's uuid, username, and creation timestamp.
