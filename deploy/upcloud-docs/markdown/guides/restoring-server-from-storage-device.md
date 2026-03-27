# Restoring a deleted Cloud Server from an existing storage device

In this guide, we will cover how to deploy a new Cloud Server from an existing storage device. This process is useful for restoring your Cloud Server after your UpCloud account has run out of credits and the server has been deleted, which occurs [30 days after your balance runs out](/docs/getting-started/accounts/account-balance#running-out-of-balance.md) .

This method allows you to access your data and configurations, which remain available on storage devices for up to 60 days after credit depletion.

It is important to note that the new server will **not** have the same IP address as the original server, so you will need to update any DNS records or applications that depend on the previous IP address.

1. Deploy a server in the same location as your storage. This should be the same plan as the original server. If you are unsure where your storage is located, you can see it under [Storage > Devices](https://hub.upcloud.com/storage/devices) on the control panel.

   *Optional*:
   Use shutdown `-h now` in the Initialization script to automatically shutdown the server.
2. Once the server is fully deployed and started, shut it down.
3. After the server has shut down, select the server, then select the Storage tab.
4. Detach the new storage, using the Detach button as shown below.

   ![Detaching storage from a server in the UpCloud Control Panel](detach_storage.png)
5. Select **Attach existing storage.**

   ![Selecting the Attach existing storage option in the UpCloud Control Panel](attach_existing_storage.png)
6. Select your old storage device, usually the first one. The default storage controller is VirtiO and should be left selected for the best performance unless the original server used a different controller.
7. Start the server and [connect](/docs/guides/connecting-to-your-server.md) to it using its IP address. The login credentials will be the same as the one on the old (deleted) server.
8. Once you have accessed your server, check if the storage device is mounted. You can use the command lsblk.

   ![Terminal output of the lsblk command showing mounted storage devices](lsblk_output.png)

You should see the mount location of the drive under the MOUNTPOINT column. If your storage is not mounted, you can review the guide on [mounting a new disk manually](/docs/guides/adding-removing-storage-devices#mounting-a-new-disk-manually.md).

Your server is now all set up with the original data and a new IP address. You might need to update some services with the new IP address, such as DNS records. There will also be a new storage device from the server that can be deleted.
