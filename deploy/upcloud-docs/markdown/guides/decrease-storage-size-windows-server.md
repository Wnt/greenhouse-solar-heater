# Safely decreasing storage size on Windows Cloud Servers

In this guide, we'll show you how to decrease the storage size of your Windows Server using *Hasleo Disk Clone* software.

It is always important to back up your server before changing the size of the storage. There is a potential risk of permanent data loss.

**This is what you will need to complete this guide**

1. Your Windows Server

   ![Windows Server](windows-server.png)
2. A new *temporary* Windows Server

   ![Temporary Windows Server](temporary-windows-server.png)
3. [Hasleo Disk Clone](https://www.easyuefi.com/disk-clone/disk-clone-home.md) software installed on your server (`my-windows-server`).

**Step 1: Take a backup of your Windows server's current storage device**

Go to your Windows server (`my-windows-server`) > Backups > Create an ‘On demand backup’ of `my-windows-server`:

![Creating an on-demand backup for Windows Server](create-on-demand-backup.png)

**Step 2: Create new temporary Windows server**

1. Create a new temporary Windows Server (`temp-windows-server`) with the storage adjusted to your desired size.

   You can simply select the smaller or other Plan (General purpose, High CPU, High memory) that you want to use.

   - The new server must be in the same zone as your Windows Server.
2. Once you have created your temporary Windows server, you need to shut it down.
3. Then go to its Storage section and click detach on its storage:

   ![Detaching storage from the temporary Windows Server](detach-temporary-server-storage.png)
4. You can now delete `temp-windows-server`.

**Step 3: Attach the temporary server’s disk to your Windows server**

1. Shutdown your Windows Server (`my-windows-server`).
2. Go to your server > Storage > Attach existing storage (`temp-windows-server` storage device).

   ![Attaching existing storage to the main Windows Server](attach-existing-storage.png)

   This will attach the temporary Windows Server’s storage to your Windows server that you want to scale down. E.g:

   ![Overview of attached storage devices on Windows Server](attached-storage-overview.png)
3. Start the Windows Server.

**Step 4: Configure disk and connect to your Windows server**

1. You can use RDP or the web console to connect to your Windows server again.
2. Navigate to Disk Management to inspect the added storage.

   ![Disk Management view showing multiple storage devices](disk-management-view.png)
3. Shrink your Windows Server `C:` drive to be able to clone it to the attached drive.

   ![Shrinking the C: drive in Disk Management](shrink-c-drive.png)
4. Accept the default values.
5. Click ‘Shrink’.

   You should now see that your disk has gone down in size with Unallocated space:

   ![Disk Management showing shrunken C: drive with unallocated space](shrunken-disk-with-unallocated-space.png)
6. Bring the new disk online:

   ![Bringing the new disk online in Disk Management](bring-new-disk-online.png)

**Step 5: Install the Hasleo Disk Clone software**

**NOTE:** You may get a Disk Management error if you haven't updated your Windows server for a while, but this can be ignored or you can update Windows, we recommend the latter.

1. Download and Install the [Hasleo Disk Clone](https://www.easyuefi.com/disk-clone/disk-clone-home.md) software onto your Windows Server.

   Accept the agreement, and accept the default settings so that you can install the software.

   ![Installing Hasleo Disk Clone software](hasleo-disk-clone-installation.png)

   On the Hasleo Disk Clone software you will see three different cloning options: System Clone, Disk Clone, Partition Clone.
2. Select System Clone, then select the disk that you want to clone, then click next.

   ![Selecting System Clone option in Hasleo Disk Clone](hasleo-system-clone-selection.png)
3. On the next page, select the disk that you want to clone to (e.g. `temp-windows-server` drive).
4. Select ‘Keep partition layout’.
5. Click next.

   ![Selecting the destination disk for cloning in Hasleo Disk Clone](hasleo-clone-destination-selection.png)
6. On the next page you can leave everything at the default settings.
7. Click ‘Proceed’.

   ![Configuring clone settings in Hasleo Disk Clone](hasleo-clone-settings.png)
8. Click ‘Yes’ to destroy all data on the selected drive.

   ![Confirming data destruction on the destination disk](hasleo-confirm-data-destruction.png)


   Wait for it to clone to the new disk.

   ![Disk cloning progress in Hasleo Disk Clone](hasleo-cloning-progress.png)
9. When cloning is done, Click **‘Finish’**.

**Step 6: Configure your newly cloned drive**

1. Go to Disk Management and extend the Unallocated space on the smaller disk (if any is available).

   ![Extending volume with unallocated space in Disk Management](extend-volume-unallocated-space.png)
2. Accept all defaults to extend the disk volume.

   Your new disk should look like this:

   ![Disk Management showing the extended disk volume](extended-disk-volume.png)
3. You can now shutdown your Windows server.

   - Hub and Windows shutdown will both work the same.

**Step 7: Configure and resize your Windows server plan**

1. Go to the UpCloud Control Panel > Your Windows Server > Storage > Detach the larger storage.

   ![][image19]

   ![Detaching the larger storage device in UpCloud Control Panel](detach-larger-storage.png)
2. Click ‘Continue’ to confirm that you want to eject this device. You can re-attach it later.

   You should now only have the smaller drive:

   ![UpCloud Control Panel showing only the smaller drive attached](remaining-smaller-drive.png)
3. Go to your Server’s Plan page and select the plan that matches the storage you have attached.

   ![Selecting a new server plan in UpCloud Control Panel](select-new-server-plan.png)
4. Click ‘Save changes’.
5. Start your Windows server.
6. RDP into your server using the same Windows server credentials.

Success! We managed to reduce our disk size! You can see the new size in your Disk Management

![Disk Management showing the reduced disk size](reduced-disk-size-confirmation.png)

**Optional:**

Once you have checked that everything is working with your Windows Server with reduced storage. You are now ready to remove the old storage.

1. Navigate to Storage > [Devices](https://hub.upcloud.com/storage/devices), and delete the older larger storage disk:

   ![Deleting the old larger storage device in UpCloud Control Panel](delete-old-storage-device.png)
2. Navigate to Storage > [Backups](https://hub.upcloud.com/storage/backups), and delete the older backup:

   ![Deleting the old backup in UpCloud Control Panel](delete-old-backup.png)
