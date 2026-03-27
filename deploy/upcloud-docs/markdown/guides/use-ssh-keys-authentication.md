# How to generate and use SSH keys for secure authentication on Linux, macOS, and Windows

SSH (Secure Shell) is a protocol used for secure remote access to servers and other network devices. When you connect to a server using SSH, you usually authenticate using a username and password. However, using SSH keys for authentication provides a more secure and convenient alternative.

SSH keys, generated with `ssh-keygen`, are a pair of cryptographic keys - a **public key** and a **private key** - that are used to authenticate and establish secure, encrypted connection between a client (such as your Linux or macOS computer) and a server using OpenSSH. The public key is placed on the server you want to access, while the private key remains on your local machine. When you attempt to connect to the server, the SSH protocol uses these keys to verify your identity and establish a secure connection without the need for a password.

Using SSH keys offers several benefits:

- Enhanced security: SSH keys are much harder to crack or guess compared to passwords, making your server access more secure.
- Convenience: Once you have set up SSH keys, you can connect to your server without having to enter a password each time, simplifying the login process.
- Automation: SSH keys enable you to automate server access for scripts and other tools, as you don't need to input a password manually.

In this guide, we will walk you through the process of generating SSH keys using OpenSSH and PuTTY, and show you how to save the keys to your UpCloud Control Panel, allowing you to securely manage your Cloud Servers.

## OpenSSH

To generate a new SSH key pair on Linux or macOS, open a terminal and use the `ssh-keygen` command. If you are on Windows, you can use PuTTYgen to generate SSH keys - which we have outlined later in the guide.

```
ssh-keygen -t rsa
```

The key generator will ask for the location and file name to which the key is saved. Enter a new name or use the default by pressing enter.

(Optional) Create a passphrase to protect your SSH private key, providing an extra layer of security when using `SSH key authentication`.
This is a simple password that will protect your private key should someone be able to get their hands on it. Enter the passphrase you wish, or continue without a passphrase. Press enter twice. Note that some automation tools might not be able to unlock passphrase-protected private keys.

Copy the public half of the key pair to your cloud server using the command below.
Replace the user and server with your username and the server address you wish to use the key authentication on.

```
ssh-copy-id -i ~/.ssh/id_rsa.pub user@server
```

This also assumes you saved the key pair using the default file name and location. If not, just replace the key path `~/.ssh/id_rsa.pub` above with the path and name of your key.

Enter your user account password for that SSH server when prompted.

You can now authenticate to your server with the key pair, but at the moment you would need to enter the passphrase every time you connect.

(Optional) Set up SSH Agent to store the keys to avoid having to re-enter the passphrase at every login
Enter the following commands to start the agent and add the private SSH key.

```
ssh-agent $BASH
ssh-add ~/.ssh/id_rsa
```

Type in your key’s current passphrase when asked. If you saved the private key somewhere other than the default location and name, you’ll have to specify it when adding the key.

You can now paste the public key in your clipboard into the UpCloud Control Panel. This can be done on the server deployment page by clicking Add new, or from the SSH keys section under the [Account management page](https://hub.upcloud.com/account/ssh).

![Login method selection screen showing SSH keys (selected) and One time password options, with an 'Add new' button for adding SSH keys.](img/image-5.png)

![Account settings page showing SSH keys tab with no keys added and an 'Add new' button.](img/image-6.png)

When adding the public key, be sure to give it a name that will help you identify it in the future. Click the Save button to save your changes.

![Dialog box for adding a new SSH key, showing a name field, a text area containing an SSH key in OpenSSH format, and a 'Save the SSH key' button.](img/image-7.png)

The newly added key should now appear in the list of SSH keys and can be selected when deploying a new server.

![Login method screen showing a key added and option to add more keys.](img/image-8.png)

Afterwards, you can [connect to your cloud server](/docs/guides/connecting-to-your-server#openssh.md) using the keys for authentication and only have to enter the passphrase (if you created one) once after every computer restart.

## PuTTY

If you're using a Windows laptop or PC with the [PuTTY SSH client](https://putty.software/), you can create a new SSH key pair using the built- in key generator called PuTTYgen.

To generate a new key, open PuTTYgen and click the Generate button.

![PuTTY Key Generator window, showing options to generate or load keys, and RSA selected as the key type with 2048 bits.](img/image.png)

In the Key Generator window, check that the type of key to generate at the bottom is set to RSA. This will create an SSH-2 RSA key. The older SSH-1 was the standard’s first version but is now considered obsolete.

Keep moving your mouse over the blank area in any manner to generate some randomness for a few moments until the progress is complete.

![PuTTY Key Generator in progress, showing a green progress bar and instructions to move mouse for generating randomness.](img/image-3.png)

When the process completes, two keys will be generated, a **private key** and a **public key**.

You can enter an optional key passphrase in the two empty fields for added security before continuing. The passphrase, if provided, will protect your key from unauthorized use in the event that someone manages to copy it.

Now save the private key somewhere safe on your computer by clicking the ‘Save private key’ button. Then copy the entire text of the public key to your clipboard. There is no need to save the public key to your computer as it can easily be regenerated by loading the private key.

![PuTTY Key Generator showing a generated SSH public key.](img/image-4.png)

You can now paste the public key in your clipboard into the UpCloud Control Panel. This can be done on the server deployment page by clicking Add new, or from the SSH keys section under the [Account management page](https://hub.upcloud.com/account/ssh).

![Login method selection screen showing SSH keys (selected) and One time password options, with an 'Add new' button for adding SSH keys.](img/image-5.png)

![Account settings page showing SSH keys tab with no keys added and an 'Add new' button.](img/image-6.png)

When adding the public key, be sure to give it a name that will help you identify it in the future. Click the Save button to save your changes.

![Dialog box for adding a new SSH key, showing a name, a text area containing an SSH key in OpenSSH format, and a 'Save the SSH key' button.](img/image-7.png)

The newly added key should now appear in the list of SSH keys and can be selected when deploying a new server.

![Login method screen showing a key added and option to add more keys.](img/image-8.png)

You can go ahead and deploy the server now. When the deployment is complete, you can [connect to the cloud server](/docs/guides/connecting-to-your-server#putty.md).

## Turn off password authentication

Once you’ve configured SSH key authentication, you can disable password authentication entirely to block brute-force attacks. This ensures your server, whether running on Linux or Windows, is fully secured by the `OpenSSH` protocol and `RSA keys`.

When logged in to your cloud server:

1. Open the SSH configuration file with the following command.

```
sudo nano /etc/ssh/sshd_config
```

2. Set the password authentication to no to disable clear text passwords.

```
PasswordAuthentication no
```

3. Check that public key authentication is enabled, just to be safe and not get locked out from your server. If you do find yourself unable to log in with SSH, you can always use the Web terminal at your UpCloud control panel.

```
PubkeyAuthentication yes
```

Then save and exit the editor.

4. Restart the SSH service to apply the changes by using the command below.

```
sudo systemctl restart sshd
```

With that done your cloud server is now another step towards security. Malicious attempts to connect to your server will result in authentication rejection, as plain passwords are not allowed, and brute-forcing an RSA key is practically impossible.

Remember to always keep your private keys safe. You can use the same key from multiple computers if you wish, or generate new ones on each client connecting to your cloud server for added security. Ideally, each user should generate their own key pair and passphrase for secure access control. With proper management, even if one of the private keys gets compromised, you won't have to replace them all.
