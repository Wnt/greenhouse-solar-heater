# How to apply user access policies using the API

In the previous sections, you created a user for your Object Storage instance and generated access keys for them. To control the permissions and actions the user can perform on the stored objects, you need to apply user access policies.

User access policies define the specific permissions granted to a user, such as the ability to read, write, or delete objects in the Object Storage instance. UpCloud provides a set of predefined policies that you can apply to your users.

Before applying a policy, let's explore how to list all available policies for your Object Storage instance. To do this, you'll need the uuid of your Object Storage instance. Make sure to replace `{uuid}` in the API request below with the actual uuid of your Object Storage instance.

Using your API client, make the following request to list all available policies:

```
GET https://api.upcloud.com/1.3/object-storage-2/{uuid}/policies
```

The API will return a response containing a list of available policies, along with their names and descriptions. Review the policies and choose the one that best fits your user's requirements.

To apply a policy to a user, you'll need the uuid of the Object Storage instance, the username of the user, and the name of the policy you want to apply. Make sure to replace `{uuid}` in the API request with the uuid of your Object Storage instance, `{username}` with the username of the user, and `{policy}` with the name of the policy you wish to apply to the user.

Using your API client, make the following request to apply a policy to the user:

```
POST https://api.upcloud.com/1.3/object-storage-2/{uuid}/users/{username}/policies

{
  "name": "{policy}"
}
```

For example, if your Object Storage instance has a uuid of `129c9eb1-9927-44cf-a4d1-fd8c78826556`, the username is `my-user`, and you want to apply the `ECSS3FullAccess` policy, the API request would look like this:

```
POST https://api.upcloud.com/1.3/object-storage-2/{uuid}/users/{username}/policies

{
  "name": "ECSS3FullAccess"
}
```

The API will return a response confirming that the policy has been applied to the user.

With the user access policy in place, your user now has the specified permissions to interact with the objects in your Object Storage instance based on the policy you applied.

You have now successfully created an Object Storage instance, created a user, generated access keys, and applied a user access policy using the UpCloud API. Your user is ready to start managing objects in your Object Storage instance.
