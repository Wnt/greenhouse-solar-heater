# Moving Cloud Servers between Public and Private clouds

Customers who contract for UpCloud's Private Cloud services and who are already utilising our Public Cloud services might subsequently wish to migrate onto Private Cloud. The Relocate server feature allows customers to move a Cloud Server along with all of its storage devices and related backups from one zone to another within a data center.

This operation can be used to move Cloud Servers from the Public Cloud to a Private Cloud or vice versa.

It can also be used to move Cloud Servers from one Private Cloud zone to another.

## Requirements

For the relocation to succeed, both source and destination zones need to reside in the same physical location, i.e. data center. Relocating a server between data centers is not currently supported.

Before relocating a Cloud Server, it must adhere to the following limitations.

### Network limitations

- The server cannot be attached to an SDN Private Network
- The server cannot have IP addresses from a dedicated, customer-owned IP network

### Operation limitations

- The server must be in a stopped state
- Attached storage devices must be in an online state
- Backups must be in an online state

## Notice of costs

Using the Relocate Server feature does not incur costs, however, because relocating a Cloud Server changes the zone of the server, its storages and their backups, the operation could affect the billing of these resources.

For example, relocating a server from a Private Cloud zone to a Public Cloud zone will move the resources onto our standard hourly rate according to the corresponding data center as listed in our [Cloud Server pricing](https://upcloud.com/pricing/#cloud-servers).

## Tooling

Private Cloud customers have the option to initiate the relocation using any of the provided tooling options. The Relocate server feature is available via the following tools:

- UpCloud API
- Go SDK
- UpCloud command-line client

## UpCloud API usage example

The Relocate Server operation can be initiated via the [UpCloud API](/docs/guides/getting-started-upcloud-api.md) using the following POST request and body contents. Customers must identify the target server using its UUID and the target zone by its name.

**Request**

```
POST /1.3/server/{uuid}/relocate HTTP/1.1
```

```
{
  "zone": "fi-priv-example"
}
```

**Attributes**

| Attributes | Accepted value | Required | Description |
| --- | --- | --- | --- |
| zone | A valid zone identifier | yes | The zone where the server should be relocated to. |

## UpCloud CLI usage example

Relocating a Cloud Server is quick and easy using the [UpCloud CLI](/docs/guides/upcloud-command-line-interface.md) by issuing the following command.

- The target server can be identified by its UUID, title or hostname
- The target zone must be identified by name

```
upctl server relocate <UUID/Title/Hostname> --zone fi-priv-example
```

## Go SDK usage example

It's also possible to use the Relocate Server feature via our Go SDK. The following example outlines the required function structure to complete the operation.

```
func (s *relocateCommand) Execute(exec commands.Executor, uuid string) (output.Output, error) {
    svc := exec.Server()
    msg := fmt.Sprintf("Relocating server %v to zone %v", uuid, s.zone)
    exec.PushProgressStarted(msg)

    res, err := svc.RelocateServer(exec.Context(), &request.RelocateServerRequest{
        UUID: uuid,
        Zone: s.zone,
    })
    if err != nil {
        return commands.HandleError(exec, msg, err)
    }

    exec.PushProgressSuccess(msg)

    return output.OnlyMarshaled{Value: res}, nil
}
```

Refer to our [Go package documentation](https://pkg.go.dev/github.com/UpCloudLtd/upcloud-go-api) for further details.
