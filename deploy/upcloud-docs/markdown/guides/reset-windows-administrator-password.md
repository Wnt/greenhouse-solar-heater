# How to reset Windows administrator password

Strong system security requires equally strong passwords, which, in turn, make the passwords more difficult to remember. In such a case that the password for the Windows administrator user account is lost without an alternative method, you might end up locked out of your system. Resetting the Administrator password of your Windows cloud server is straightforward and will, typically, only take a few minutes to complete.

## Setting up the password reset environment

1. Create an [On demand backup](/docs/guides/taking-backups.md#on-demand-backups.md) of your Windows storage device to avoid potentially losing data!
2. Proceed to shut down your Windows server (the server that needs the Administrator password to be reset) via the Windows operating system interface as shown below:

![image.png](image.png)

A prompt will appear to also select the reason you are shutting down the server. You may pick any relevant reason; i.e. **Other (Planned).**

3. Once the Windows server has been successfully shut down. Proceed to the **Storage** tab of your Windows server.

![image.png](image-1.png)

4. On the **Storage** tab, take note of the storage device name, and then proceed to **Detach** this storage device from the Windows server you need the password reset.

![image.png](image-2.png)

1. Once the above step is completed and you have successfully detached the Windows storage device from your original Windows server, you must deploy a new Linux server within the **SAME data centre location as your Windows server.**

![image.png](image-3.png)

6. Once your temporary Linux server has been started, please proceed to shut down the temporary Linux server you just deployed. We need to attach the Windows storage you detached in **Step 3**.

![image.png](image-4.png)

7. Once the temporary Linux server has been shut down, go to the **Storage** tab as shown in Step 2 for the temporary Linux server to attach the Windows storage.

![image.png](image-5.png)

Once the **“Add new device”** button has been selected on the temporary Linux server; proceed to select the **“Attach existing device”** menu.

![image.png](image-6.png)

Click on the **“Device list”** drop-down to select the detached Windows storage.

![image.png](image-7.png)

Once the original Windows storage device has been selected; click the **“Add a storage device”** button to complete the attachment of the storage device to the temporary Linux server.

**Note:** If your Windows server doesn’t appear in the drop-down, you may need to refresh the page. Also, ensure that you have deployed the Linux server in the same data centre as the Windows server.

Your Linux server should now have two storage devices.

![image.png](image-8.png)

8. Start the temporary Linux server.

![image.png](image-9.png)

## Working with chntpw and ntfs-3g

1. [Connect](/docs/guides/connecting-to-your-server.md) to your Linux cloud server.

```
ssh root@<my-ip-address>
The authenticity of host '<my-ip-address> (<my-ip-address>)' can't be established.
ED25519 key fingerprint is SHA256:KwyszmIdsm61X9opfwdHJM55nxOj4BROZ0vU6/aUvrA.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
Warning: Permanently added '<my-ip-address>' (ED25519) to the list of known hosts.
```

2. Update the repositories and install **chntpw** and **ntfs-3g**.

```
apt update
apt install chntpw ntfs-3g -y
```

3. Find the name of your Windows storage device.

```
lsblk
NAME   MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS
vda    253:0    0    50G  0 disk # Our Linux Storage
├─vda1 253:1    0     1M  0 part
└─vda2 253:2    0    50G  0 part /
vdb    253:16   0   160G  0 disk # Our Windows Storage
├─vdb1 253:17   0   100M  0 part
└─vdb2 253:18   0 159.9G  0 part
```

You will see your Linux storage device (**/dev/vda1**) and the Windows storage device (**/dev/vdb2**). Use the **-p** flag to see the full device path.

**Note:** **sfdisk -l** or any other preferred method will work as well.

4. Create a mount point to the Windows storage.

```
mkdir /mnt/Microsoft/
```

5. Mount the Windows storage to the **/mnt/Microsoft** directory.

```
mount -o rw /dev/vdb2 /mnt/Microsoft/
```

6. Set read, and write permissions with **ntfs-3g**.

```
ntfs-3g -o rw /dev/vdb2 /mnt/Microsoft/
```

**Note:** If you get the error: “Mount is denied because the NTFS volume is already exclusively opened”. Ignore it and continue to the next command below.

7. Use **chntpw** to begin resetting the Administrator password.

```
chntpw -i /mnt/Microsoft/Windows/System32/config/SAM
```

You will now see the **chntpw** console. Type **"1"** and hit **Enter** to select **“Edit user data and passwords”.**

```
chntpw version 1.00 140201, (c) Petter N Hagen
Hive </mnt/Microsoft/Windows/System32/config/SAM> name (from header): <\SystemRoot\System32\Config\SAM>
ROOT KEY at offset: 0x001020 * Subkey indexing type is: 686c <lh>
File size 65536 [10000] bytes, containing 7 pages (+ 1 headerpage)
Used for data: 343/36312 blocks/bytes, unused: 33/8520 blocks/bytes.

<>========<> chntpw Main Interactive Menu <>========<>

Loaded hives: </mnt/Microsoft/Windows/System32/config/SAM>

 1 - Edit user data and passwords
 2 - List groups
  - - -
 9 - Registry editor, now with full write support!
 q - Quit (you will be asked if there is something to save)

What to do? [1] -> 1  # Type: 1 > Enter
```

Enter the user ID (RID) for the **Administrator** username, which is **01f4** and hit **Enter.**

```
===== chntpw Edit User Info & Passwords ====

| RID -|---------- Username ------------| Admin? |- Lock? --|
| 01f4 | Administrator                  | ADMIN  |          |
| 01f7 | DefaultAccount                 |        | dis/lock |
| 01f5 | Guest                          |        | dis/lock |
| 01f8 | WDAGUtilityAccount             |        | dis/lock |

Please enter user number (RID) or 0 to exit: [1f4] 01f4   # Type: 01f4 > Enter
```

Select **“1”** from the list to **“Clear (blank) user password”** and hit **Enter.**

```
================= USER EDIT ====================

RID     : 0500 [01f4]
Username: Administrator
fullname:
comment : Built-in account for administering the computer/domain
homedir :

00000220 = Administrators (which has 1 members)

Account bits: 0x0010 =
[ ] Disabled        | [ ] Homedir req.    | [ ] Passwd not req. |
[ ] Temp. duplicate | [X] Normal account  | [ ] NMS account     |
[ ] Domain trust ac | [ ] Wks trust act.  | [ ] Srv trust act   |
[ ] Pwd don't expir | [ ] Auto lockout    | [ ] (unknown 0x08)  |
[ ] (unknown 0x10)  | [ ] (unknown 0x20)  | [ ] (unknown 0x40)  |

Failed login count: 0, while max tries is: 0
Total  login count: 10

- - - - User Edit Menu:
1 - Clear (blank) user password
(2 - Unlock and enable user account) [seems unlocked already]
3 - Promote user (make user an administrator)
4 - Add user to a group
5 - Remove user from a group
q - Quit editing user, back to user select
Select: [q] > 1                                   # Type: 1 > Enter
Password cleared!
```

Now hit **q** and **q** again to exit this console and then hit **y** to save our changes.

```
- - - - User Edit Menu:
1 - Clear (blank) user password
(2 - Unlock and enable user account) [seems unlocked already]
3 - Promote user (make user an administrator)
4 - Add user to a group
5 - Remove user from a group
q - Quit editing user, back to user select
Select: [q] > q                                   # Type: q > Enter

<>========<> chntpw Main Interactive Menu <>========<>

Loaded hives: </mnt/Microsoft/Windows/System32/config/SAM>

 1 - Edit user data and passwords
 2 - List groups
     - - -
 9 - Registry editor, now with full write support!
 q - Quit (you will be asked if there is something to save)

What to do? [1] -> q                              # Type: q > Enter

Hives that have changed:
#  Name
0  </mnt/Microsoft/Windows/System32/config/SAM>
Write hive files? (y/n) [n] : y                   # Type: y > Enter
```

8. Once all the above steps have been completed, proceed to shut down the temporary Linux server.

```
shutdown -h now
```

## Setting a new Administrator password

1. Navigate back to the [UpCloud dashboard](https://hub.upcloud.com/server) and **Detach** the Windows server storage device from the temporary Linux server via the **Storage** tab.

![image.png](image-10.png)

2. Select your Windows server to re-attach the Windows storage device back to the original Windows server, and navigate to the **Storage** tab.

![image.png](image-11.png)

Select the **“Attach existing storage”** button and select your Windows storage.

![image.png](image-12.png)

Confirm, **“Add a storage device”**.

3. Start the Windows server now once the Windows storage device has been successfully attached back, and wait for it to boot.
4. Connect to your Windows server via the **Console connection** at your UpCloud dashboard.

![image.png](image-13.png)

Because we cleared the password you will be automatically logged in as the Administrator user. This is insecure so we will set the password to something stronger.

5. Search and open **Computer Management**.

![image.png](image-14.png)

Navigate the folder structure via: **Computer Management (Local) > System Tools > Local Users and Groups > Users.**

- Right-click on **Administrator**. Click on **Set Password > Proceed.**

![alt text](image-15.png)

alt text

**Note:** By default, Windows enforces a certain password strength requirement.

- The password must not contain the user’s account name or more than two consecutive characters from the user’s full name.
- The password must be six or more characters long.
- The password must contain characters from **three** of the following four categories:
  - Uppercase characters A-Z (Latin alphabet)
  - Lowercase characters a-z (Latin alphabet)
  - Digits 0-9
  - Special characters (!, $, #, %, etc.)

After you have set your Administrator password, log out and back in to verify that your password was set successfully.

## Cleanup

Once everything is working as expected with your newly created Windows Administrator password, you can proceed to delete the temporary Linux server. Additionally, you may remove the temporary [on demand backup](https://hub.upcloud.com/storage/backups) that was taken at the start of this process.

## Common issues

1. Mount is denied because the NTFS volume is already exclusively opened.

```
Mount is denied because the NTFS volume is already exclusively opened.
The volume may be already mounted, or another software may use it which could be identified for example by the help of the ‘fuser’ command.
```

This warning can be safely ignored.

2. The disk contains an unclean file system (0, 0).

```
The disk contains an unclean file system (0, 0).
Metadata kept in Windows cache, refused to mount.
Falling back to read-only mount because the NTFS partition is in an unsafe state. Please resume and shutdown Windows fully (no hibernation or fast restarting)
```

To resolve this error, you will need to properly shutdown the Windows server by following these steps:

1. Shutdown the Debian server.
2. Detach the Windows storage from the temporary Linux server.
3. Attach the Windows storage back to the Windows server.
4. Start the Windows server.
5. Finally, shutdown the Windows server via the OS through the web console.

After this is done, then attach the Windows storage again to the Linux server and restart the Windows password reset process.
