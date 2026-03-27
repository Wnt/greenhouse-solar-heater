# How to get started using the UpCloud API

This is a quick introduction to the UpCloud API. Will help you through the first steps of connecting to the API and automating your cloud servers using your favourite programming language. The programmable API is available at `https://api.upcloud.com`, which encompasses all of the functionality of the UpCloud control panel and then some. If you want to get started on your own, head straight to the full [API documentation](https://developers.upcloud.com/).

## Creating API credentials

The first step in getting started with our API is to create a separate API user. You can do this at the [UpCloud Control Panel](https://hub.upcloud.com/people) using the workspace member accounts. Your API account name and password are very much comparable to an API ID and key pair with the added benefit of being able to set them yourself.

Create a new workspace member for the API access by clicking the *Create subaccount* button.

![Workspace members](img/image.png)

Workspace members

Enter the contact details for your API credentials, set the API password, and enable API access in the permissions.

By default, the API account will have full permissions to any resources it creates but no access to existing servers or storage. You can grant additional permissions as needed using the server, storage, and tag access options.

Once done, click the *Create subaccount* button at the bottom.

![Create API account](img/image-1.png)

Create API account

You can create as many dedicated API accounts as you need. We recommend creating separate API credentials for each application and external service you use.

Note that you should restrict the API subaccount from your other UpCloud services. Take care handling the credentials if you are programming automation against the UpCloud API.

## Running basic API requests

Once you have created your API account, let’s try your first request. To quickly test the API, use a tool such as [Postman](http://www.getpostman.com/) (or any other API toolkit of your choice) to get started. The goal is to have the following dialogue working.

```
GET /1.3/account
```

```
HTTP/1.0 200 OK
{
    "account" : {
        "credits" : "10000",
        "username" : "username"
    }
}
```

Using a GET request, enter the API address https://api.upcloud.com with the API version number and the desired command to the request URL line, then select the Basic Auth option and set your username and password. When you have filled in the request details, click the *Send* button to run the query.

![Postman GET Account](img/image-2.png)

Postman GET Account

The reply will be shown in the bottom half of the Postman window under the *Body* tab.

The authentication method of our API is the HTTP Basic authentication where the Authorization header should contain your API username and password Base64 encoded. More precisely:

```
# Python3
import base64
base64.b64encode("username:password".encode())
```

```
# Node.js
new Buffer("username:password").toString('base64');
```

In Postman the authorization header line should look as shown below with your Base64 encoded credentials.

![Postman Basic Auth header](img/image-3.png)

Postman Basic Auth header

Using a similar request by just replacing the query target from account to server you can get the full list of servers your API account is allowed to access.

```
GET /1.3/server
```

```
HTTP/1.0 200 OK
{
    "servers": {
        "server": [
            {
                "core_number": "1",
                "hostname": "example.upcloud.com",
                "license": 0,
                "memory_amount": "1024",
                "plan": "1xCPU-1GB",
                "state": "started",
                "tags": {
                    "tag": []
                },
                "title": "Example UpCloud server",
                "uuid": "00e8051f-86af-468b-b932-4fe4ac6c7f08",
                "zone": "fi-hel1"
            }
        ]
    }
}
```

You should now be able to form similar requests to the ones above using the API. For example, `GET /1.3/server/00e8051f-86af-468b-b932-4fe4ac6c7f08`, will reply with full details of that specific host when you include the UUID of one of your servers in a query.

## Using the API programmatically

The API can be accessed using any language that has proper HTTP libraries. The following snippet shows how you could take advantage of the UpCloud API using Python3.

```
import http.client
import base64

conn = http.client.HTTPSConnection("api.upcloud.com")
auth = base64.b64encode("username:password".encode())
headers = {"Authorization": "Basic " + auth.decode()}

conn.request("GET", "/1.3/account", None, headers)
res = conn.getresponse()
print( res.read().decode() )
```

For a bit more sensible approach, the example below shows how you could structure the code for a better approach. The BaseAPI forms a generic API (GET) request that is extended by the Account class to form the same API request as above. Adding additional GET requests would now be much easier.

```
import http.client
import base64

class BaseAPI:
    api = "api.upcloud.com"
    api_v = "1.3"
    token = base64.b64encode("username:password".encode())

    '''
    Performs a GET request to a given endpoint in UpCloud's API.
    '''
    def get(self, endpoint):
        conn = http.client.HTTPSConnection(self.api)
        url = "/" + self.api_v + endpoint
        headers = {
            "Authorization": "Basic " + self.token.decode(),
            "Content-Type": "application/json"
        }
        conn.request("GET", url, None, headers)
        res = conn.getresponse()
        self.printresponse(res.read())

    '''
    Prints the response (bytes) as a string to the user
    '''
    def printresponse(self, res):
        data = res.decode(encoding="UTF-8")
        print(data)

class Account(BaseAPI):
    endpoint="/account"

    def do(self):
        self.get(self.endpoint)

if __name__ == "__main__":
    Account().do()
```

## More about the UpCloud API

These are just a couple of the simplest examples of what the UpCloud API allows you to do. Now that you have got the hang of the API usage, continue on to [deploying a new server with UpCloud API](/docs/guides/deploying-server-upcloud-api.md).
