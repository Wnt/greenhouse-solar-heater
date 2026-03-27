# How to get started with UpCloud Command-Line Interface

UpCloud Command-Line Interface, or UpCloud CLI for short, is a text-based user interface to UpCloud’s Infrastructure-as-a-service. It provides a fast command-line tool for accessing and managing your UpCloud resources.

UpCloud CLI allows you to control your Cloud Servers, storage and networking from your local command line with simple and intuitive command structures. It’s offered as an addition to the current methods such as the UpCloud Control Panel and API for all users but especially developers and system administrators will likely find it highly useful!

In this guide, we’ll show you how to install the UpCloud CLI on your own computer and go over some of the basic functions.

## Setting up API access

Before you can begin, you first need to enable API access to your UpCloud account.

We recommend creating a separate workspace username and password for every API integration for easier access control. To do so, go to your [UpCloud Control Panel](https://hub.upcloud.com/people) under the People section.

- Click the *Create subaccount* button
- Choose your API username
- Enter the contact details for your API credentials
- Set the API password

When ready, click the *Create subaccount* button to save.

After creating the subaccount, you will need to configure permissions for it:

- Switch to permissions tab and click the *Edit* button on the row where the newly created subaccount is listed.
- Enable API access in the permissions
- Grant all permissions for existing servers, storage, and tags

You can find more detailed instructions on API credentials in our guide for [getting started with UpCloud API](/docs/guides/getting-started-upcloud-api.md).

Afterwards, you need to store your API credentials on your own computer.

To do so, create a config file called upctl.yaml with user credentials in the `.config` folder in your home directory ($HOME/.config/upctl.yaml)

```
username: your_upcloud_username
password: your_upcloud_password
```

Alternatively, your credentials can also be stored in the environment variables `UPCLOUD_USERNAME` and `UPCLOUD_PASSWORD`. If the variables are set, matching config file items are ignored.

## Installing the UpCloud CLI

Now that you’ve enabled API access to your UpCloud account, you can get started.

Go ahead and download the [latest release of the UpCloud CLI](https://github.com/UpCloudLtd/upcloud-cli/releases) from our GitHub repository. Pick the release as appropriate for your operating system.

Then make the file executable and move it to a directory found in your PATH environmental variable. For example, the following commands will do the trick on most Linux systems.

### macOS

On macOS, you can install the command-line interface using Brew. First, add the repository and then run the install command as shown below.

```
brew tap UpCloudLtd/tap
brew install upcloud-cli
```

UpCloud CLI also supports bash-completion but setting it up requires a few more commands.

```
brew install bash-completion
sudo upctl completion bash > /usr/local/etc/bash_completion.d/upctl
echo "[ -f /usr/local/etc/bash_completion ] && . /usr/local/etc/bash_completion" >> ~/.bash_profile . /usr/local/etc/bash_completion
```

### Linux

UpCloud CLI is available for a number of popular distributions e.g. Debian, Ubuntu and Arch Linux.

**AUR**

On Arch Linux, you can install the CLI with the following command.

```
yay -S upcloud-cli
```

**Ubuntu and other Debian based distributions**

Use the package corresponding to your Linux distribution, such as deb, rpm, or apk. For example, to install UpCloud CLI on Debian or Ubuntu, use the following commands.

```
sudo curl -L -o upcloud.deb https://github.com/UpCloudLtd/upcloud-cli/releases/download/v<VERSION>/upcloud-cli-<VERSION>_amd64.deb
sudo dpkg -i upcloud.deb
```

**Other Linux distributions**

If you can’t find a package applicable to your flavour of Linux, you can always use the precompiled version. Download and extract the CLI to a suitable location, for example, `$HOME/.local/bin` directory.

```
sudo curl -L -o upcloud-cli.tar.gz https://github.com/UpCloudLtd/upcloud-cli/releases/download/v<VERSION>/upcloud-cli_<VERSION>_linux_x86_64.tar.gz
tar -C $HOME/.local/bin -xf upcloud-cli_<VERSION>_linux_x86_64.tar.gz
```

Bash completion can also be set up with some extra commands. You should adapt this for your package manager.

```
sudo apt install bash-completion
upctl completion bash | sudo tee /etc/bash_completion.d/upctl
echo "[ -f /etc/bash_completion ] && . /etc/bash_completion" >> ~/.bash_profile . /etc/bash_completion
```

### Windows

Windows users can also make use of the UpCloud Command-Line Interface. Simply download the ZIP file, extract it and run the portable executable. No installation is required.

```
Invoke-WebRequest -Uri "https://github.com/UpCloudLtd/upcloud-cli/releases/download/v<VERSION>/upcloud-cli-<VERSION>_windows_x86_64.zip" -OutFile "upcloud-cli.zip"
unzip upcloud-cli.zip
upctl.exe -h
```

## Testing basic commands

Once you’ve enabled API access and installed the UpCloud CLI, you are ready to get cracking.

First, check the top-level command options. The help output is printed by default on most commands to make the CLI easy to explore and learn.

```
upctl --help
```

```
Usage:
upctl [command]

Available Commands:
account     Manage account
completion  Generates shell completion
help        Help about any command
ip-address  Manage ip address
network     Manage network
router      Manage router
server      Manage servers
storage     Manage storages
version     Display software information
```

If the CLI is working, test that it is able to access your UpCloud API credentials.

**Account** command lets you check the details of your UpCloud account.

```
upctl account show
```

```
  Username: maxupcloud
  Credits:  98.47$

  Resource Limits:
    Cores:                    100
    Detached Floating IPs:      0
    Memory:                307200
    Networks:                 100
    Public IPv4:               20
    Public IPv6:              100
    Storage HDD:            10240
    Storage SSD:            10240
```

**Server** command is a top-level command that you will likely be using a fair bit. Run the following command to list all Cloud Servers your API account has permission to.

```
upctl server list
```

```
 UUID                                   Hostname             Plan        Zone      State
────────────────────────────────────── ──────────────────── ─────────── ───────── ─────────
 00229ddf-0e46-45b5-a8f7-cad2c8d11f6a   server1              2xCPU-4GB   de-fra1   stopped
 003c9d77-0237-4ee7-b3a1-306efba456dc   server2              1xCPU-2GB   sg-sin1   started
```

**Storage** command can be used to manage both your own cloud storage devices as well as explore the public templates. The next command will list all public templates.

```
upctl storage list --public
```

The command outputs can also be piped to other command-line tools. For example, use grep to narrow down the list of templates to find a specific public template.

```
upctl storage list --public | grep Debian
```

```
 01000000-0000-4000-8000-000020030101   Debian GNU/Linux 8.6.0 (Jessie) Installation CD           cdrom         1   online                 public   0001-01-01 00:00:00 +0000 UTC
 01000000-0000-4000-8000-000020040100   Debian GNU/Linux 9 (Stretch)                              template      3   online                 public   0001-01-01 00:00:00 +0000 UTC
 01000000-0000-4000-8000-000020040101   Debian GNU/Linux 9.0.0 (Stretch) Installation CD          cdrom         1   online                 public   0001-01-01 00:00:00 +0000 UTC
 01000000-0000-4000-8000-000020050100   Debian GNU/Linux 10 (Buster)                              template      3   online                 public   0001-01-01 00:00:00 +0000 UTC
 01000000-0000-4000-8000-000020050102   Debian GNU/Linux 10.0.0 (Buster) Installation CD         cdrom         1   online                 public   0001-01-01 00:00:00 +0000 UTC
```

Other commands include options for managing your networking such as static and floating IP addresses, SDN Private networks and SDN Routers. We’ll go more into detail on this further ahead in this guide.

## Cloud Servers

One of the main benefits of the UpCloud CLI is the speed and ease of managing your cloud services. For example, deploying a new Cloud Server takes but a single command.

The example below deploys a new Cloud Server using the 2xCPU-4GB General purpose plan running Debian 10. It also allows you to secure the server right from deployment by enabling SSH keys and disabling password login.

```
upctl server create
--zone de-fra1
--plan 2xCPU-4GB
--os-storage-size 80
--os "Debian GNU/Linux 10 (Buster)"
--ssh-keys ~/.ssh/id_rsa.pub
--create-password false
--hostname example.com
--title "Example server"
```

You can find the full detailed list of the configuration parameters using the command below.

```
upctl server create --help
```

Once deployed, check the status of the new server.

Notice how using the UpCloud CLI, you do not need to remember UUIDs. Rather most resources can be addressed by their name as in the example command below.

```
upctl server show example.com
```

```
  Common
    UUID:          00eeab44-1670-4fc2-b858-c99477fdf78b
    Hostname:      example.com
    Title:         Example server
    Plan:          2xCPU-4GB
    Zone:          de-fra1
    State:         started
...
```

The example output above shows the first few lines of details about the Cloud Server.

If you want to make changes to your Cloud Server, e.g. change the hostname or description, enable Firewall or Metadata, many of the changes can be done without shutting down the server.

```
upctl server modify example.com --metadata true
```

However, if you want to change the server plan, you first need to shut down the server.

```
upctl server stop example.com
```

Wait a moment for the Cloud Server to shut down gracefully.

Afterwards, you can make changes to the server configuration.

```
upctl server modify example.com --plan 4xCPU-8GB
```

Then start up the server again.

```
upctl server start example.com
```

That’s it! Your Cloud Server should then start up momentarily with the additional resources available right away.

## Storage devices

All Cloud Servers deployed using General purpose plans offer ample storage out of the gate but sometimes you just need more capacity. Luckily, UpCloud CLI offers quick and easy commands for creating additional storage devices and attaching them to your Cloud Server.

Furthermore, most storage operations can even be done without shutting down the server!

**Create new storage devices** by defining the type, size, and location, as well as naming the storage. For example, let’s create a secondary MaxIOPS storage for our example.com Cloud Server.

```
upctl storage create
  --title example.com-storage1
  --size 50
  --zone de-fra1
  --tier maxiops
```

Once created, you can query the storage devices for details using the command below.

```
upctl storage show example.com-storage1
```

**Attaching storage** devices to a server is as easy as creating them.

Note that here the storage device needs to be identified by its UUID. This can be found in the device details using the command above.

```
upctl server storage attach example.com --storage 0116d96d-a655-4c45-b773-e729831c8df7
```

Then check the server details again to see that the new storage device was attached successfully.

```
upctl server show example.com
```

```
...
  Storage: (Flags: B = bootdisk, P = part of plan)

     UUID                                   Title                  Type   Address    Size (GiB)   Flags
    ────────────────────────────────────── ────────────────────── ────── ────────── ──────────── ───────
     019ec51c-f3ee-4112-ad89-d6396402181d   example.com-osDisk     disk   virtio:0           80   P
     0116d96d-a655-4c45-b773-e729831c8df7   example.com-storage1   disk   virtio:1           50
...
```

Quick and easy! However, after attaching new storage devices, it’s still necessary to finish the process at the operating system level. You can find out more about formatting the storage device in our guide on [adding storage devices](/docs/guides/adding-removing-storage-devices.md).

## Networks and IP addresses

Networking is also an important part of any cloud infrastructure and naturally, you can manage yours via the UpCloud CLI.

**Creating SDN Private networks** is a great way for securely connecting Cloud Servers. Let’s test out the command-line interface by setting up a new SDN Private network for our example.com Cloud Server.

```
upctl network create --name sdn.example --zone de-fra1 --ip-network 'address=192.168.10.1/24,dhcp=true'
```

When done, check that the network you created was added to the list.

```
upctl network list

 UUID                                   Name          Router   Type      Zone
────────────────────────────────────── ───────────── ──────── ───────── ─────────
 03ba4ed0-55f4-4832-8fab-efd7a6cc0f91   sdn.example            private   de-fra1
```

Now that we have our network ready, let’s attach our Cloud Server to it.

First, however, we’ll need to shut down the server.

```
upctl server stop example.com
```

The shutdown will take a second, once done you can continue.

**Create a new network interface** and **attach SDN Private network** to it with the command below. Note that with this command, the network needs to be addressed via its UUID.

```
upctl server network-interface create example.com --network 03ba4ed0-55f4-4832-8fab-efd7a6cc0f91
```

Afterwards, start up the server again.

```
upctl server start example.com
```

Besides networks, UpCloud CLI also allows you to manage your individual IP addresses.

**Create a new floating IP address** with the example command below.

```
upctl ip-address assign --floating true --zone de-fra1
```

Once created, the new floating IP will show up on the list of IP addresses. The command below will show all IP addresses reserved to your UpCloud account.

```
upctl ip-address list
```

```
 Address                                   Access    Family   Part of Plan   PTR Record                                    Server                                 Floating   Zone
───────────────────────────────────────── ───────── ──────── ────────────── ───────────────────────────────────────────── ────────────────────────────────────── ────────── ─────────
 2a04:3542:1000:910:6cd7:1bff:febf:7605    public    IPv6     no             6cd7-1bff-febf-7605.v6.de-fra1.upcloud.host   00eeab44-1670-4fc2-b858-c99477fdf78b   no         de-fra1
 10.4.15.153                               utility   IPv4     no                                                           00eeab44-1670-4fc2-b858-c99477fdf78b   no         de-fra1
 94.237.98.120                             public    IPv4     no             94-237-98-120.de-fra1.upcloud.host                                                   yes        de-fra1
 94.237.103.26                             public    IPv4     yes            94-237-103-26.de-fra1.upcloud.host            00eeab44-1670-4fc2-b858-c99477fdf78b   no         de-fra1
```

**Attach the floating IP address** to the example.com server with the next command. For this, you will need the MAC address of one of the public network interfaces on your Cloud Server. Commonly this should be the first public IP address on your Cloud Server. Check the output from `upctl server show example.com` to find the right one.

```
upctl ip-address modify 94.237.98.120 --mac 6e:d7:1b:bf:64:94
```

When attached, the floating IP address will show up to your Cloud Server. However, to enable network traffic through the floating IP, you would still need to configure it on the operating system level. Check out our other guides on OS-specific instructions for [attaching floating IP addresses](/docs/guides/configure-floating-ip-debian.md).

## Conclusions

Congratulations! By following along and completing the steps explained in this guide, you should now have a pretty good grasp of the UpCloud Command-Line Interface. It really makes it quick work managing your cloud infrastructure!

Additionally, using the UpCloud CLI, you could easily script and automate common tasks to further speed up your workflow. You might be surprised at how much can be accomplished with a few simple lines of clever commands.
