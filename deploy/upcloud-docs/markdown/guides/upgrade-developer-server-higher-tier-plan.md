# Upgrading a Developer plan server to a higher-tier plan

If you find that you have outgrown the Developer plan server that you started with, it's possible to upgrade to one of our higher-tier preconfigured plans: General Purpose, High Memory, or High CPU. These plans use MaxIOPS storage, which offers improved read and write performance compared to the Standard tier storage used by Developer plan servers.

This tutorial guides you through the process of upgrading a developer server to a higher-tier plan. We'll cover the following key steps:

1. Creating an on-demand backup
2. Cloning the existing storage to MaxIOPS® using the UpCloud API
3. Detaching the old storage and attaching the new MaxIOPS® storage
4. Upgrading the server plan
5. Resizing the storage (if needed)
6. Verifying the changes

By following this tutorial, you'll be able to upgrade your server's [performance](/docs/products/block-storage/tiers.md) while minimising downtime. The process involves using both the UpCloud control panel and API, so make sure you have access to both before starting.

Note: This tutorial assumes you're familiar with basic server management concepts and have experience working with cloud platforms. If you're new to UpCloud, it's recommended to [review our documentation first](/docs/getting-started.md).

Begin by creating a backup of your current server configuration.

By [creating an on-demand backup](/docs/guides/taking-backups.md) you can easily restore your server back to its initial state should something go wrong.

After the backup has finished, shut down the server.

Then navigate to the Storage tab of the server and copy the storage UUID.

![Copying the storage UUID from the server's Storage tab in the UpCloud control panel](copy-storage-uuid.png)

Using the API, clone the storage to MaxIOPS®. Ensure that you use the same zone (data centre location) as the existing server and that you create a name or “title” for the cloned storage.

If you are unfamiliar with using the UpCloud API please refer to our [getting started](/docs/guides/getting-started-upcloud-api.md) guide.

Once you’ve authenticated; create a POST request via the API, and replace the UUID placeholder with the storage UUID you’ve copied above.

```
POST /1.3/storage/{uuid}/clone HTTP/1.1

{
  "storage": {
    "zone": "fi-hel1",
    "tier": "maxiops",
    "title": "your server's storage name here"
  }
}
```

Replace “***fi-hel1”*** with your respective zone. The related API documentation can be found [here](https://developers.upcloud.com/1.3/9-storages/#clone-storage).

The expected successful response is **201 Created**. If you get an error, please refer to the [Possible responses](https://developers.upcloud.com/1.3/9-storages/#clone-storage) table for a solution or reach out to our 24/7 Support team for assistance.

### Alternative method:

Using the [UpCloud CLI](/docs/guides/get-started-upcloud-command-line-interface.md) run the following command.

```
upctl storage clone {storage_uuid} --title {example_storage_clone} --zone {my-zone1} --tier maxiops
```

The new storage will be created.

On the control panel, you should be able to see the new disk on the [Storage > Devices](https://hub.upcloud.com/storage/devices) page.

![Newly created MaxIOPS storage visible on the Storage Devices page in the UpCloud control panel](new-maxiops-storage-created.png)

Once the new MaxIOPS® storage is created, return to the Developer server and navigate to the **Storage** tab again, then ***Detach*** the Standard tier storage.

![Detaching the Standard tier storage from the server in the Storage tab](detach-standard-tier-storage.png)

Then attach the new MaxIOPS® storage you cloned earlier.

![Attaching the new MaxIOPS storage to the server in the Storage tab](attach-maxiops-storage.png)

Finally, choose to ***add a storage device***.

![Selecting the newly created MaxIOPS storage in the Add storage device dialog](select-maxiops-storage.png)

**Note:** If you dont see the new storage right away, close the popup and try again. If you still don’t see it verify that the new storage is in the same data centre zone as the server.

Ensure the the newly attached storage is tier MaxIOPS®, then (if no other changes are needed) ***Start*** your server.

![Verifying the attached MaxIOPS storage and starting the server from the Storage tab](verify-maxiops-storage-attached.png)

You can go ahead and change our server plan to the higher tier you want. After that is done, ***Save changes***. This plan change can be done when the server is shutdown or when the server is started, by using the [**Live Resizing**](/docs/guides/scale-cloud-servers-hot-resize.md) feature.

![Changing the server plan to a higher-tier in the Plan tab and saving the changes](change-server-plan.png)

Optionally, you may also want to increase the storage amount to match your new plan. This must be done manually via the **Storage** tab when your server is shutdown.

Navigate to the **Storage** tab and select the ***Edit*** button.

![Changing the server plan to a higher-tier in the Plan tab and saving the changes](edit-storage-size.png)

Change the storage space amount to the amount that your new plan allows (in GB). Then choose ***Save changes and resize filesystem & partition***.

**Note:** If you plan to manually create a secondary partition then choose the ***Save changes*** option instead.

![Resizing the storage and filesystem partition in the Edit storage dialog](resize-storage-and-filesystem.png)

This process will create a new on-demand backup that can be used to restore this server.

Wait for the storage to exit the **Maintenance** and **Syncing** state. The duration for this wait period changes depending on the size of the storage that must be synced, i.e. larger storages will take longer to complete.

Once that finishes, then **Start** your server.

![Starting the server after the storage has been resized, from the server's Overview tab](start-server-after-storage-resize.png)

Your server’s login credentials will remain the same. Ensure that you can login to your server and that there are no unexpected issues.

```
root@example-server:~# lsblk
NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS
vda	253:0	0  80G  0 disk
├─vda1 253:1	0   1M  0 part
└─vda2 253:2	0  80G  0 part / 				    # My storage

root@example-server:~# df -h
Filesystem  	Size  Used Avail Use% Mounted on
tmpfs       	387M  5.9M  381M   2% /run
/dev/vda2    	79G  2.3G   74G    4% / 			# My storage
tmpfs       	1.9G 	0  1.9G    0% /dev/shm
tmpfs       	5.0M 	0  5.0M    0% /run/lock
tmpfs       	387M   12K  387M   1% /run/user/0
```

### Optional Cleanup

If everything works, you can remove the unnecessary resources. **Do note that once resources are deleted they cannot be restored.**

1. Delete the original Standard tier storage.
   - On the control panel, Navigate to [Storage > Devices](https://hub.upcloud.com/storage/devices) and press the ***Delete*** button.

     ![Deleting the original Standard tier storage from the Storage Devices page](delete-original-standard-storage.png)
2. Delete the on-demand backups.
   - Go to the Backups tab on your server and scroll down to the History section and delete the Resize Backup
   - Delete the Initial Backup via the [Storage > Backups](https://hub.upcloud.com/storage/backups) page.
