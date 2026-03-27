# Metadata service

UpCloud Metadata service allows users to query information about the server itself. The data can be utilised, for example, as the basis for the automatic configuration of the servers after the initial deployment.

## Enabling Metadata service

Metadata service can be selected at deployment or enabled on any existing Cloud Servers at the user's UpCloud Control Panel or via the UpCloud API. The initial deployment of Cloud Servers using new public templates which require SSH-key only need to have Metadata service enabled.

Cloud Servers deployed without the Metadata service can enable it at any point without the need to restart the server. This can be done either via the UpCloud Control Panel in the server Optional settings or by using the UpCloud API.

The toggle for the Metadata service can be found in the Cloud Server settings under the Optional settings.

Alternatively, metadata service can be enabled with the following API request by replacing the server-UUID with the UUID of the user's Cloud Server.

```
PUT /1.3/server/server-UUID/
{
   "server": {
      "metadata": "yes"
    }
}
```

## Querying metadata

The Metadata is available as a cloud-init compatible JSON and via a filesystem-like traversable API. Both can be queried on any of the user's Cloud Servers using any HTTP client such as curl or wget.

Metadata is available to be queried through all networks: public, utility and SDN private networks.

## Metadata endpoint

```
http://169.254.169.254/metadata/v1.json
```

Metadata allows users to find specific information about resources which can include multiples of the same type, for example, storage and networks.

Below is a list of all currently available fields provided by the Metadata service.

### Cloud name

```
"cloud_name": "upcloud"
```

The name of the cloud provider - for inter compatibility

### Instance ID

```
"instance_id": "00bf9504-a4cb-4839-88ff-124a2c95e169"
```

The UUID is generated at deployment

### Hostname

```
"hostname": "metadata.example.com"
```

The Cloud Server's hostname as defined by the user

### Platform

```
"platform": "servers"
```

The type of platform in use

### Subplatform

```
"subplatform": "metadata (http://169.254.169.254)"
```

The Metadata endpoint address

### Public keys

```
"public_keys": [
  "ssh-rsa AAAAB[...]ud1Cw== [email protected]"
]
```

The SSH keys included by the user

### Region

```
"region": "de-fra1"
```

The Server location

### Network

```
"network": {
  "interfaces": [
    {
      "index": 1,
      "ip_addresses": [
        {
          "address": "94.237.90.209",
          "dhcp": true,
          "dns": [
            "94.237.127.9",
            "94.237.40.9"
          ],
          "family": "IPv4",
          "floating": false,
          "gateway": "94.237.90.1",
          "network": "94.237.90.0/24"
        }
      ],
      "mac": "de:ad:be:ef:3f:c5",
      "network_id": "03030473-8e9d-4f4f-bcfe-b2c300391a07",
      "type": "public"
    },
  ]
  "dns": [
    "94.237.127.9",
    "94.237.40.9"
  ]
}
```

The Network interfaces and DNS addresses configured to the server

### Storage

```
"storage": {
  "disks": [
    {
      "id": "0187b8c5-7220-4c90-9026-047dff8be0b3",
      "serial": "0187b8c572204c909026",
      "size": 25,
      "type": "disk",
      "tier": "maxiops"
    }
  ]
}
```

All storage devices attached to the server

### Tags

```
"tags": [
  "dev",
  "metadata"
]
```

User-defined tags assigned to the Cloud Server

### User data

```
"user_data": "apt-get update && apt-get -y upgrade"
```

The Initialization script used during deployment, or its URL.

### Vendor data

```
"vendor_data": " "
```

Any specific data field can be queried using the filesystem-like traversable API. For example, the following query can be used to get the IP address of the first network interfaces.

```
http://169.254.169.254/metadata/v1/network/interfaces/1/ip_addresses/0/address
```

The Metadata service will then return the value of the queried field omitting the key. Meaning the output can be used directly without additional formatting.

```
94.237.90.209
```

The main advantage of Metadata allows it to be used to configure applications and services which require server-specific information that is not known before deployment.
