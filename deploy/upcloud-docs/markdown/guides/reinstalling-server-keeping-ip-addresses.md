# Reinstalling your server while keeping the IP address

If you ever need to get a fresh install of your cloud server, but would also want to keep the IP addresses from your old host, then this guide is for you.

You can easily reinstall the operating system for your server by using the OS Reinstall feature in the control panel. The steps for this are outlined below:

After shutting down your server, navigate to the Storage tab and select the 'Reinstall OS' button.

![Storage tab](img/image.png)

Storage tab

Next, select your new operating system; either Linux or Windows-based OS will work. Make sure to select the OS that matches your current server if you want to use the same environment.

![OS selection](img/image-1.png)

OS selection

Change your storage name (or leave it as the default), and choose whether to delete the original storage device or to keep it as a backup. The new storage size will be identical to the current storage’s size.

Important: Keeping the original storage is highly recommended as a backup. This is crucial for restoring your original state if any issues occur during the reinstallation process.

![Storage creation](img/image-2.png)

Storage creation

The original storage device can be found under [Storage > Devices](https://hub.upcloud.com/storage).

Select your SSH keys or a one time password. If using a Windows OS, you will only receive the latter option.

![Login method](img/image-3.png)

Login method

Then click Reinstall.

After successfully reinstalling your OS, consider these important next steps:

1. Update your system: Run system updates to ensure you have the latest security patches
2. Reconfigure your applications: Reinstall and configure any necessary software for your server
3. Restore your data: If you kept your original storage or had a backup, now is the time to restore your important data. Or if you do not need these anymore, you can proceed to delete it from your [Storage list](https://hub.upcloud.com/storage) if you no longer need it
4. Review security settings: Double-check your firewall rules and access controls
5. Test your services: Ensure all your services and applications are functioning correctly
6. Monitor performance: Keep an eye on your server's performance over the next few days to ensure everything is running smoothly

## Summary

You should now have a clean installation of the OS of your choosing up and running with all the previously configured resources. To get started again you may wish to take a look at our guide for [how to secure your Linux cloud server](https://upcloud.com/resources/tutorials/secure-linux-cloud-server/).
