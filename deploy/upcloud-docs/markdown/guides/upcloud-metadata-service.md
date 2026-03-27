# Using the UpCloud Metadata service

UpCloud provides a Metadata service that allows you to query information on already deployed cloud servers to get information about the server itself. The data can be utilised as the basis for the automatic configuration of the servers after the initial deployment.

## Enabling the metadata service

Metadata service can be selected at deployment or enabled on any existing Cloud Servers at your UpCloud Control Panel or via the API. For example, the Metadata service is used to include your SSH keys and run initialization scripts at deployment.

The feature can be turned on or off at the deployment page under the Optional settings.

![Metadata enabled at server deployment](img/deploy-server.png)

Cloud Servers deployed without the service can enable it at any point without the need to restart the server. This can be done either via the UpCloud Control Panel or the UpCloud API.

You can find the option to turn on Metadata in your Cloud Server settings under the Optional settings.

![Metadata server details overview](img/metadata-server-options-e1585573961144.png)

Alternatively, you can enable the metadata service with a simple API request. Replace the server-UUID with the UUID of your cloud server.

```
PUT /1.3/server/server-UUID/
```

```
{
   "server": {
      "metadata": "yes"
    }
}
```

If you’ve not used the UpCloud API before, have a look at our [getting started guide](/docs/guides/getting-started-upcloud-api.md) to learn more.

## Listing all metadata

Metadata is available to be queried through all networks: public, utility and SDN private networks.

The metadata is available as a cloud-init compatible JSON and via a filesystem-like traversable API. Both can be queried on any of your cloud servers using any HTTP client such as `curl` or `wget`.

For example, you can use the following request to view all of the metadata available on your cloud server.

```
curl http://169.254.169.254/metadata/v1.json
```

```
{
  "cloud_name": "upcloud",
  "instance_id": "00bf9504-a4cb-4839-88ff-124a2c95e169",
  "hostname": "metadata.example.com",
  "platform": "servers",
  "subplatform": "metadata (http://169.254.169.254)",
  "public_keys": [
    "ssh-rsa AAAAB[...]ud1Cw== [[email protected]](/cdn-cgi/l/email-protection)"
  ],
  "region": "de-fra1",
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
      {
        "index": 2,
        "ip_addresses": [
          {
            "address": "10.199.12.11",
            "dhcp": true,
            "dns": null,
            "family": "IPv4",
            "floating": false,
            "gateway": "10.199.12.1",
            "network": "10.199.12.0/24"
          }
        ],
        "mac": "de:ad:be:ef:9f:ff",
        "network_id": "03318153-4e70-4ba5-8e74-69538582188d",
        "type": "utility"
      },
      {
        "index": 3,
        "ip_addresses": [
          {
            "address": "2a04:3540:1000:811:9809:21ff:fe8b:5962",
            "dhcp": true,
            "dns": [
              "2a04:3540:53::1",
              "2a04:3544:53::1"
            ],
            "family": "IPv6",
            "floating": false,
            "gateway": "2a04:3540:1000:811::1",
            "network": "2a04:3540:1000:811::/64"
          }
        ],
        "mac": "9a:09:21:8b:59:62",
        "network_id": "03000000-0000-4000-8002-000000000000",
        "type": "public"
      }
    ],
    "dns": [
      "94.237.127.9",
      "94.237.40.9"
    ]
  },
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
  },
  "tags": [
    "dev",
    "metadata"
  ],
  "user_data": "apt-get update && apt-get -y upgrade",
  "vendor_data": ""
}
```

## Getting specific metadata

UpCloud metadata service can also be accessed via a filesystem-like traversable API. This allows you to find specific data about resources that can include multiples of the same type, for example, storage and networks.

List all available fields with the following request.

```
curl http://169.254.169.254/metadata/v1/
```

```
cloud_name
instance_id
hostname
platform
subplatform
public_keys
region
network/
storage/
tags
user_data
vendor_data
```

Specific information can be retrieved using the full path of the field, for example, with the request below to get the cloud server region.

```
curl http://169.254.169.254/metadata/v1/region
```

```
fi-hel1
```

Data fields with the / icon at the end indicate nested fields that work like directories. You can traverse these directories to view their content. For example, you can list the network interfaces using the request below.

```
curl http://169.254.169.254/metadata/v1/network/interfaces/
```

```
1/
2/
3/
```

You can get detailed information about any of the network interfaces by going further into the data structure. For example, find the IP address on the first interface which usually holds the public IP.

```
curl http://169.254.169.254/metadata/v1/network/interfaces/1/ip_addresses/0/address
```

```
94.237.90.209
```

The metadata can then be used to configure applications and services which require server-specific information that is not known before deployment.
