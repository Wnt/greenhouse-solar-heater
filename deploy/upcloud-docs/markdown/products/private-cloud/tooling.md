# Tooling available for Private Clouds

Private Clouds are managed by the same tools as UpCloud's public cloud services. These tools include the [Hub](https://hub.upcloud.com/), the [API](/docs/tooling/api.md) and its [SDKs](/docs/tooling/sdk.md), [Terraform](/docs/tooling/terraform-with-upcloud.md) and the [Command-Line Interface (upctl) - [/docs/tooling/cli.md). The available tooling has been expanded with special Private Cloud features to add visibility to Cloud Server hosts and to enable cherry picking hosts on which to start Cloud Servers. ## Private Cloud on the Hub Private Cloud adds the visibility to Cloud Server hosts on the Hub. The Private Cloud page allows seeing all available Private Cloud hosts and their CPU and memory usage. ![Private Cloud host selection on the hub](../capacity-management/host-selection.png)

When deploying a Cloud Server, it can be placed on the Private Cloud hosts from the Location section. A server can be moved from a host to another by shutting it down, changing the selected host, and starting the server. The migration is immediate and does not require copying data since UpCloud [stores all block storage on a storage network](/docs/products/block-storage/storage-system.md).

## Available tooling

Private Clouds are supported by all UpCloud tooling, including:

- [UpCloud API](/docs/tooling/api.md)
- [API SDKs](/docs/tooling/sdk.md)
- [Terraform](/docs/tooling/terraform-with-upcloud.md)
- [UpCloud Command-Line Client](/docs/tooling/cli.md)

## Private Cloud on the API

Private Clouds are [visible on the API](https://developers.upcloud.com/1.3/14-hosts/) through the `/host` endpoint and enable picking the host in the [Start server endpoint](https://developers.upcloud.com/1.3/8-servers/#start-server).

### Listing Private Cloud hosts

```
GET /1.3/host

{
  "hosts": {
    "host": [
      {
        "id": 7653311107,
        "description": "´Private host #1",
        "zone": "de-exa1",
        "windows_enabled": "no",
        "stats": {
          "stat": [
            {
              "name": "cpu_idle",
              "timestamp": "2019-08-09T12:46:57Z",
              "value": 87
            },
            {
              "name": "memory_free",
              "timestamp": "2019-08-09T12:46:57Z",
              "value": 172
            }
          ]
        }
      },
      {
        "id": 8055964291,
        "description": "Private host #2",
        "zone": "de-exa1",
        "windows_enabled": "no",
        "stats": {
          "stat": [
            {
              "name": "cpu_idle",
              "timestamp": "2019-08-09T12:46:57Z",
              "value": 73
            },
            {
              "name": "memory_free",
              "timestamp": "2019-08-09T12:46:57Z",
              "value": 128
            }
          ]
        }
      }
    ]
  }
}
```

The `windows_enabled` field indicates whether Windows Server licensing has been enabled on the host. Cloud Servers using a Windows Server template must be run on licensed hosts. All other operating systems can be run on any host.

See the [API documentation](https://developers.upcloud.com/1.3/14-hosts/) for details.

### Create server with Private Cloud host selection

The Private Cloud host can be cherry picked by setting the `host` field. If the field is unset, a host will be automatically selected, as in the public cloud.

```
POST /1.3/server

{
  "server": {
    "zone": "de-exa1",
	"host": "7653311107",
    "title": "Private test server",
    "hostname": "test.example.com",
    "core_number": "2",
	"memory_amount": "4096",
    "storage_devices": {
      "storage_device": [
        {
          "action": "clone",
          "storage": "01000000-0000-4000-8000-000030220200",
          "title": "Ubuntu 22.04 LTS",
          "size": 50,
          "tier": "maxiops"
        }
      ]
    },
    "networking": {
      "interfaces": {
        "interface": [
          {
            "ip_addresses": {
              "ip_address": [
                {
                  "family": "IPv4"
                }
              ]
            },
            "type": "utility"
          }
        ]
      }
    },
		"metadata": "yes",
    "login_user": {
       "username": "upclouduser",
       "ssh_keys": {
         "ssh_key": [
            "ssh-rsa AAAAB3NzaC1yc2EAA ptshi44x [email protected]",
            "ssh-dss AAAAB3NzaC1kc3MAA VHRzAA== [email protected]"
          ]
       }
    }
  }
}
```
