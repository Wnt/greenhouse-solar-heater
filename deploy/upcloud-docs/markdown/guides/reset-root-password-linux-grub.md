# How to reset root password on Linux Cloud Servers using Grub

So you’ve forgotten your password, but you don’t want to deploy an additional server as described in our [reset root password guide](/docs/guides/reset-root-password-cloud-server.md), then this **Grub-based** method is for you!

![User forgot their root password](image-16.png)

## Create an on demand backup

Before we begin changing settings on the server, let's take an on demand backup. If something goes wrong, this will allow us to restore the server to its original state.

On the **Backups** page of your server, click to create an **On demand backup**.

![alt text](image-18.png)

## Reset your server password

1. If you haven't already done so, head over to the server's console tab and open the console connection.

![alt text](image-17.png)

In the console window, click the **Send Ctrl+Alt+Del** button to send that command to the server. This will cause the server to reboot.

![alt text](image-19.png)

2. Press the **Esc** key continuously on your keyboard to drop into the Grub boot menu. If Esc doesn't work, try pressing the **Shift** button instead. If you see the login screen, it means you've missed the opportunity to enter the Grub menu and will need to restart the process by clicking the **Send Ctrl+Alt+Del** button again.

![alt text](image-3.png)

3. When the grub menu appears, press **‘e’** to edit the grub boot commands.

4. Add `init=/bin/bash` to the line that starts with **linux**.

![alt text](image-13.png)

5. Save this change with **ctrl+x** on your keyboard or with **F10** to allow Grub to boot with this setting. Either method will work.

**Note:** This setting is not saved and will be overwritten by the default grub config for the next boot.

You will be dropped into a different shell automatically. For example, **root@(none):/#**

![alt text](image-26.png)

6. Try to reset the root password with the passwd command:

![alt text](image-23.png)

7. If you receive an "Authentication token manipulation error", you'll need to remount the root partition with read and write permissions:

```
mount -o remount,rw /
```

Try the `passwd` command again. This time it should work.

![alt text](image-22.png)

**Note:** If your operating system uses SELinux in enforcing mode (typically Rocky Linux and AlmaLinux), you may also need to reset the contexts by using `autorelabel` after you change the password.

To do this, create the autorelabel file using this command:

```
touch /.autorelabel
```

This is not a required step, but if your password was changed successfully, and after the reboot, you still get the wrong password error, then this is likely the culprit.

8. If you had to remount the filesystem as read-write in step 7, you should now remount it as read-only to prevent filesystem corruption:

```
mount -o remount,ro /
```

9. You can now reboot the server. However, the **reboot** and **shutdown** commands will not work in this recovery environment.

![alt text](image-25.png)

Use `exec /sbin/init` command instead, or press the **Send Ctrl+Alt+Del** button in the top right-hand corner of the console window.

![alt text](image-19.png)

10. After the server reboots, you should now be able to log in with your newly set password!

![alt text](image-28.png)

## Optional steps

Delete the On-demand backup we created earlier. You can do this either from the **History** section of your server's **Backups** section.

![alt text](image-30.png)

Or via the [Storage > Backups](https://hub.upcloud.com/storage/backups) page on the dashboard.

![alt text](image-29.png)
