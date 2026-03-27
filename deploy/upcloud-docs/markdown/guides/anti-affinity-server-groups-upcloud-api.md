# How to enable Anti-affinity with the UpCloud API

High availability is practically the bare minimum for modern web services and there’s no better way to increase availability than through redundancy. Creating additional Cloud Servers to host your application is simple enough, however, there’s a chance your resources end up running on the same physical host which in the case of a hardware failure could still cause downtime. Not so when employing Server Groups with anti-affinity enabled!

Server Groups enable you to bundle your Cloud Servers for easier organisation and management. Furthermore, these groups allow you to enact an anti-affinity policy. Anti-affinity in turn is used to provide high availability to applications utilising multiple Cloud Servers by distributing the servers to different physical hosts to ensure true redundancy.

## Creating a new Server Group

The Server Group and anti-affinity features are provided via the [UpCloud API](https://developers.upcloud.com/1.3/8-servers/#attributes_5) at no cost to the customer. If you are new to UpCloud API, check out our [getting started with UpCloud API guide](/docs/guides/getting-started-upcloud-api.md) to get up to speed.

Begin by calling the endpoint shown below and creating a new Server Group. Include the following parameters in the body of your API request.

1. Name your Server Group by setting a title.
2. You can also already add existing servers to the Server Group by including each Cloud Server’s UUID.
3. To enable anti-affinity conditions, make sure to include the parameter and set it as yes.

```
POST /1.3/server-group
```

```
{
  "server_group": {
    "title": "App servers",
    "servers": {
      "server": [
        "00dd7d47-da91-44f0-9898-73d7a4de5ad2",
        "0038c967-0713-4ba2-a9da-9c532023849f"
      ]
    },
    "anti_affinity": "yes"
  }
}
```

A normal response will look similar to the example below.

```
HTTP/1.1 200 OK

{
    "server_group": {
        "anti_affinity": "yes",
        "anti_affinity_status": [
            {
                "status": "unmet",
                "uuid": "0038c967-0713-4ba2-a9da-9c532023849f"
            },
            {
                "status": "unmet",
                "uuid": "00dd7d47-da91-44f0-9898-73d7a4de5ad2"
            }
        ],
        "labels": {
            "label": []
        },
        "servers": {
            "server": [
                "0038c967-0713-4ba2-a9da-9c532023849f",
                "00dd7d47-da91-44f0-9898-73d7a4de5ad2"
            ]
        },
        "title": "App servers",
        "uuid": "0ba3e07d-3733-4e43-8230-183d708e6055"
    }
}
```

Notice that just adding Cloud Servers to a group will not automatically distribute them between different hosts. You can see the status of the anti-affinity conditions like in the response example above, or by querying the Server Group endpoint with your group UUID.

The status of the server’s anti-affinity can be checked via group info or group list endpoints. If the status is met, the server is the only one on that physical host. If the status is unmet, the server shares the same host machine with another Cloud Server from the same anti-affinity group.

## Adding Cloud Servers to an existing server group

Including Cloud Servers in a Server Group with anti-affinity enabled allows you to increase the redundancy of your cloud services. The anti-affinity conditions are observed during the Cloud Server creation and start-up phases by allocating the Cloud Server to a host without any other members of the same Server Group.

Cloud Servers can be added to the Server Group already at creation by including the Server Group UUID in the server creation API query.

```
POST /1.3/server/
```

```
{
   ...
  "server" : {
    "server_group": {server_group_uuid}
  }
   ...
}
```

It’s also possible to add the Server Group UUID to an already running Cloud Server.

```
PUT /1.3/server/{uuid}
```

```
{
  "server" : {
    "server_group": {server_group_uuid}
  }
}
```

Alternatively, you can call the Server Group API endpoint to include multiple Cloud Servers in the same group in one go.

```
PATCH /1.3/server-group/{server_group_uuid}
```

```
{
  "server_group": {
    "title": "App servers",
    "servers": {
      "server": [
        "00e2dc05-379d-6b90-a354-e5c3f9293918",
        "00451e12-46ee-41a0-8a52-1aff9039298a"
      ]
    },
    "anti_affinity": "yes"
  }
}
```

Grouped servers will aim to avoid physical hosts that already have members from the same group. In the unlikely situation where all available hosts already have a member of the same Server Group, starting the Cloud Server will be prioritised over the anti-affinity conditions.

A server can belong to only one group. To be able to move a Cloud Server to another group, it must first be removed from its current group.

## Meeting the anti-affinity conditions

Adding new Cloud Servers to a Server Group already at creation helps to have the server allocated on a host that meets the anti-affinity conditions. However, adding already running servers to a group has the possibility of finding multiple Cloud Servers running on the same host, and therefore, not meeting the anti-affinity conditions.

If your Server Group has Cloud Servers that are listed as anti-affinity “status unmet”, you will need to restart at least one of the servers. The anti-affinity conditions are then observed during the start-up phases and the Cloud Server is started on a new host.

You can issue a restart command to a Cloud Server using the following API request. Notice that the stop type needs to be set to **hard** to have the server perform a full power cycle.

```
POST /1.3/server/{uuid}/restart
```

```
{
  "restart_server": {
    "stop_type": "hard"
  }
}
```

After sending the restart command, wait a moment for the server to reboot. Then check your Server Group to see the status of the anti-affinity conditions.

```
GET /1.3/server-group/{server_group_uuid}
```

A normal response with anti-affinity conditions satisfied will look similar to the example below.

```
HTTP/1.1 200 OK

{
    "server_group": {
        "anti_affinity": "yes",
        "anti_affinity_status": [
            {
                "status": "met",
                "uuid": "0038c967-0713-4ba2-a9da-9c532023849f"
            },
            {
                "status": "met",
                "uuid": "00dd7d47-da91-44f0-9898-73d7a4de5ad2"
            }
        ],
        "labels": {
            "label": []
        },
        "servers": {
            "server": [
                "0038c967-0713-4ba2-a9da-9c532023849f",
                "00dd7d47-da91-44f0-9898-73d7a4de5ad2"
            ]
        },
        "title": "App servers",
        "uuid": "0ba3e07d-3733-4e43-8230-183d708e6055"
    }
}
```

Your Cloud Servers are then running on different hosts ensuring high availability even in the case of hardware failure.

## Conclusions

Server Groups and anti-affinity are crucial features for building truly redundant services without single points of failure. These features are made available through the UpCloud API and their usage is entirely free of charge. So don’t hesitate and enable anti-affinity on your Cloud Servers today!
