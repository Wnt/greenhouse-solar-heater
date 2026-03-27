# Managing storage devices

Storage disks are separated from the actual servers; while the server offers CPU, RAM, IP addresses, firewall rules etc. the storage device is where the operating system lives. You can attach the storage to another server, create custom images from the storage, or delete storage without deleting the server. While attaching storage to a server happens in the server settings, other actions can also be performed at the Storage view in your [UpCloud control pane](https://hub.upcloud.com/).

## Storage devices

If you want to create a template that you can use to spin new custom instances, you can do so at the Storage view in the control panel. This is handy if you’ve configured the server [using your own installation media](/docs/guides/using-own-install-media.md) or by [importing your own server image](/docs/guides/importing-server-image.md). Or if you’ve set up a configuration that you’ll want to use later, for example, by setting up your perfect LAMP stack.

There are a couple of things to note: you can only create templates from MaxIOPS storage and the server that the device is attached to should be shut down.

## Attaching, detaching and deleting storage

Attaching and detaching storage are done at the server settings. In the Resize view, you can detach or delete devices that are currently attached or attach new or existing storage. If you detach a device, it still remains in your Storage view in the control panel and is also billed according to our standard [pricing](https://upcloud.com/pricing/). Deleting a storage device removes it completely from your account and the data is lost permanently.

Storages can also be deleted at the Storage view in your control panel. Always proceed with caution when deleting storage devices.

![Deleting storage](img/image-2.png)

## Resizing storage

All storage devices on UpCloud are block-storage and can be scaled up when not in active use. Note that you can only scale up using this method as downscaling could risk deleting data on your storage device.

Go to your server settings and the Storage section. You can use the sliders or edit the size on the right to increase the storage space. While doing so, you’ll see the calculated new monthly cost of your server based on your selections.

While using our general purpose server plans, keep the system storage as is and [add a secondary storage device](/docs/guides/adding-removing-storage-devices.md) per your needs to retain the plan pricing.

Once you’ve set the storage sizes to their new values, click the *Save changes* button to confirm.

![Adding storage](img/image-3.png)

Scaling up a device will allocate more storage space to your server. However, the changes are not updated automatically on your operating system. This is somewhat technical due to different OS requirements. We have separate guides to help with the process of [resizing storage devices](/docs/guides/increasing-storage-size.md).
