# Deploying Cloud Servers using the UpCloud API

This article describes some of the features of the UpCloud API and how you can go about deploying a server with API requests rather than using the UpCloud Control Panel. More details about the requests used in this article can be found in the [API documentation](https://developers.upcloud.com/).

There are three ways to create a cloud server using the API:

- from a public template
- by cloning an existing storage device
- by installing an OS manually using installation media

All of the methods use the `POST /1.3/server` requests with the Base64 authentication. To define the finer details, you will need to enter a few required parameters in the request body.

If you are not yet familiar with the UpCloud API, we suggest taking a quick look at our guide to [getting started with UpCloud API](/docs/guides/getting-started-upcloud-api.md) to set up your API user account and access rights.

## Creating a server from a template

Deploying a server using a public template is basically an operation to clone a templated operating system image on a new storage device of the desired size and type. You can get a list of the public templates with their UUIDs using the following request.

```
GET /1.3/storage/template
```

The body of a POST request to create a new server should contain the necessary details of the cloud server and at least one storage device for the operating system. The example request below uses the Ubuntu Server 22.04 LTS Jammy Jellyfish public template to deploy a server with 1 CPU core, 1GB RAM, and 25GB storage which corresponds to the first monthly plan.

Note that public templates starting with Ubuntu 22.04 require metadata to be enabled for server creation. If you do not wish to use the metadata feature, it can be disabled after server creation.

```
POST /1.3/server
{
    "server": {
        "zone": "fi-hel1",
        "title": "API Deploy Test",
        "hostname": "example.upcloud.com",
        "metadata" : "yes",
        "plan": "1xCPU-1GB",
        "storage_devices": {
            "storage_device": [
                {
                    "action": "clone",
                    "storage": "01000000-0000-4000-8000-000030220200",
                    "title": "example.upcloud.com-disk0",
                    "size": 25,
                    "tier": "maxiops"
                }
            ]
        }
    }
}
```

The other available plans can be seen with the following GET request.

```
GET /1.3/plan
```

Cloud servers deployed with a matching plan configuration are priced according to the monthly plans. In addition to the listed plans, servers can also be freely configured with a custom plan which allows greater flexibility with the CPU, memory, and storage resources.

## Cloning from an existing storage device

Cloning an existing storage device is very similar to deploying a server from a template. Compared to the previous method, you just need to change the storage UUID from a public template to another storage device on your UpCloud account. You can clone any storage that you have access rights to as long as the storage is not currently in use.

You can get a list of your storage devices with the next GET request.

```
GET /1.3/storage/private
```

As mentioned, a storage device you wish to use as the source for a cloning operation cannot be running during the process. Shut down the source server with the following request.

```
POST /1.3/server/server_UUID/stop
```

Once the source server has been powered down, you can deploy a new host by cloning the storage disk. Enter the example request body to your query and replace the **storage\_UUID** with the desired source device.

```
POST /1.3/server
{
    "server": {
        "zone": "fi-hel1",
        "title": "API Cloning Test",
        "hostname": "clone.example.upcloud.com",
        "plan": "1xCPU-1GB",
        "storage_devices": {
            "storage_device": [
                {
                    "action": "clone",
                    "storage": "storage_UUID",
                    "title": "example.upcloud.com-disk0-clone0",
                    "tier": "maxiops"
                }
            ]
        }
    }
}
```

Cloning will take a moment depending on the size of the source storage device. Until cloning is complete, both servers will be in the maintenance state.

Once the cloning process has finished, you can start the source server again with the following POST request.

```
POST /1.3/server/server_UUID/start
```

Take care when cloning large storage devices. Cloning between zones can take some time and the source host must remain powered down during the process. A way to get around this is to first clone the disk within the current zone, which is much faster, and then use the clone as a source when sending the data to a new zone.

## Creating a server from installation media

In addition to the public templates, a server can also be deployed using the available installation media of various operating systems. For example, Arch, Fedora, and Knoppix are available as CDROMs that can be used to install the OS manually at first boot.

You can get a list of CDROM UUIDs with the GET request underneath.

```
GET /1.3/storage/cdrom
```

When you have chosen the CDROM you wish to use to install a new server, run the following POST request with two storage devices; one blank disk with the size and tier you wish, and the second with the CDROM UUID and type.

To have the server boot from the CDROM, set the boot order as shown below. You might also wish to enable VNC access to go through the installation later. Otherwise, the web console is always available on your [UpCloud Control Panel](https://hub.upcloud.com/).

```
POST /1.3/server
{
    "server": {
        "zone": "fi-hel1",
        "title": "API CDROM Deploy Test",
        "hostname": "example.upcloud.com",
        "plan": "1xCPU-1GB",
        "storage_devices": {
            "storage_device" : [
                {
                    "action" : "create",
                    "size" : "25",
                    "title" : "example.upcloud.com-disk0",
                    "tier": "maxiops"
                },
                {
                    "action" : "attach",
                    "storage" : "01000000-0000-4000-8000-000070010101",
                    "type" : "cdrom"
                }
            ]
        },
        "boot_order" : "cdrom,disk",
        "vnc" : "on"
    }
}
```

Once the server has been created, you will get a reply with the server details as a confirmation including the VNC settings and password. Connect to the new host using the method you prefer and install the operating system.

When you have finished with the installation, power off the server for a moment and detach the CDROM using the POST request below.

```
POST /1.3/server/server_UUID/storage/detach
{
    "storage_device": {
        "address": "ide:0:0"
    }
}
```

All done! You can then start the custom-installed server again.

## What to do next

Now that you have a server up and running, you might wish to set up a backup solution suitable for your use case. Continue on with an article about [managing backups with UpCloud API](/docs/guides/managing-backups-upcloud-api.md), or if you would like to learn more about the requests used in this article check out the [\_Servers\_ section in the API documentation](https://developers.upcloud.com/1.3/8-servers/).
