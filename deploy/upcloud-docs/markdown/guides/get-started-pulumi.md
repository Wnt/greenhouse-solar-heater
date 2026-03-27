# How to get started with Pulumi

[Pulumi](https://www.pulumi.com/) is a modern infrastructure as code (IaC) platform that lets you safely and predictably manage your infrastructure by codifying APIs into declarative configuration files.

Just like Terraform, Pulumi enables infrastructure as code, but unlike Terraform which uses its own domain-specific language (HCL), Pulumi lets you use familiar programming languages such as Python, TypeScript, Go, and C# to name a few. For this guide, we'll be using Python as it is well-supported and is generally more accessible for a getting started guide such as this one. We will show you how to install the required software and get started with the deployment of a cloud server on UpCloud using Pulumi.

Below you can find the instructions suitable for most Linux distributions, but Pulumi is also available for download on [macOS and Windows.](https://www.pulumi.com/docs/iac/download-install)

## Installing Pulumi

The easiest way to install Pulumi on Linux is with the official installation script:

```
curl -fsSL https://get.pulumi.com | sh
```

After the installation, you may need to restart your shell.

Once installed you can verify the Pulumi installation by checking for the version number in a terminal with the command below:

```
pulumi version
```

## Logging in to Pulumi

Before you can use Pulumi to deploy resources, you need to set up state management. Pulumi state stores information about the resources you've deployed, their configurations, and relationships. This state is important because it lets Pulumi track what it has created and make the necessary updates when you change your code.

Pulumi offers two options for storing this state: using the **Pulumi Cloud service** or storing it **locally**. In either case, the command line is used for most operations, but the Pulumi Cloud service also provides a web interface with extra features like team collaboration, deployment history, and resource visualization.

#### Option 1: Pulumi Cloud (recommended)

The Pulumi Cloud service offers the most features and is the recommended way to use Pulumi, especially when working in teams.

1. Create a free account at [app.pulumi.com](https://app.pulumi.com) if you don't already have one
2. Generate an access token at [app.pulumi.com/account/tokens](https://app.pulumi.com/account/tokens)
3. Log in to Pulumi from your terminal:

```
pulumi login
```

4. When prompted, paste the access token you created, or alternatively you can authenticate in your browser using the generated URL

#### Option 2: Local storage

If you prefer not to use the Pulumi Cloud service, you can store state locally:

```
pulumi login --local
```

This will store state files in a `.pulumi` directory in your home folder.

When using local storage, you'll be asked to create a passphrase when you create your first project. This passphrase is used to encrypt your state file and you will need to enter it each time you run Pulumi commands. If you forget or lose the the passphrase, you won't be able to access your infrastructure state.

## Setting up Python

As we'll be using Python in this guide, you need to make sure you have Python 3 and pip installed.

On Ubuntu/Debian:

```
sudo apt update
sudo apt install python3 python3-pip python3-venv
```

Verify the installation:

```
python3 --version
pip3 --version
```

## Setting up UpCloud user credentials

Deploying resources to your UpCloud account requires you to authenticate with the UpCloud API. There are two methods to authenticate: using an API token (recommended) or using your username and password.

Regardless of the method used, **we recommend creating a separate workspace member with only the necessary API permissions, rather than using the main account owner's credentials.** Find out more about this in our [API guide](/docs/guides/getting-started-upcloud-api.md).

#### Option 1: Using API tokens (Recommended)

[API tokens](https://developers.upcloud.com/1.3/24-api-tokens/) provide a more secure authentication method as they have configurable expiration dates, can be restricted to specific IP addresses, and can be easily revoked if compromised. Although this feature is currently in beta, it is the recommended method for new projects.

Create a token through the UpCloud API, then store it in your environmental variables:

```
echo 'export UPCLOUD_TOKEN=ucat_01DQE3AJDEBFEKECFM558TGH2F' | tee -a ~/.bashrc
```

Replace the token above with your actual UpCloud API token.

Then reload your profile to apply the new addition:

```
source ~/.bashrc
```

#### Option 2: Using username and password

If you prefer to use the traditional authentication method or don't have access to API tokens yet, you can store your UpCloud username and password in environmental variables:

```
echo 'export UPCLOUD_USERNAME=username' | tee -a ~/.bashrc
echo 'export UPCLOUD_PASSWORD=password' | tee -a ~/.bashrc
```

Replace `username` and `password` with your UpCloud account credentials.

Then reload your profile to apply the new additions:

```
source ~/.bashrc
```

## Creating a new Pulumi project

Each Pulumi project is organised in its own directory with configuration files that define your infrastructure. Let's create a new directory for your Pulumi project and change into it.

```
mkdir -p ~/pulumi/upcloud && cd ~/pulumi/upcloud
```

Next, initialise a new Pulumi project:

```
pulumi new python
```

You'll be prompted to provide several pieces of information:

- **Project name**: Give your project a descriptive name, e.g., `upcloud` (or accept the default name based on your directory)
- **Project description**: A brief description, e.g., `A basic UpCloud Server deployment using Pulumi`
- **Stack name**: This is your deployment environment, e.g., `dev`
- **Toolchain selection**: Select **pip** for the dependency management tool (this is the standard Python package installer)

If you opted for local login, you will also be prompted to enter a passhrase to encrypt your state file. This pashrase will be required each time you run Pulumi commands.

After answering these questions, Pulumi will create your project structure and install its dependencies. When successful, you'll see a message like:

```
Installing dependencies...

Creating virtual environment...
Finished creating virtual environment
...
...
Finished installing dependencies

Your new project is ready to go!

To perform an initial deployment, run `pulumi up`
```

The output above confirms that your Pulumi project has been successfully initialised, and the basic dependencies have been installed.

Next, we'll activate the virtual environment that Pulumi created:

```
source venv/bin/activate
```

Your terminal prompt should now show (venv) at the beginning indicating that the virtual environment is now activated.

- When you're done working with your Pulumi project, you can exit the virtual environment by typing `deactivate`
- Whenever you want to work on this project again, make sure to activate the virtual environment first with `source venv/bin/activate` from your project directory

This approach follows Python best practices and avoids interfering with your system's Python installation.

## Installing the UpCloud provider

Before we can define UpCloud resources, we need to first install the UpCloud provider. With your virtual environment activated (venv should appear in your prompt), run the following command:

```
pip install "pulumi_upcloud"
```

## Defining your UpCloud server

Now that you have the UpCloud provider installed, let's configure a cloud server by editing the `__main__.py` file:

```
nano __main__.py
```

Note: The `__main__.py` file was created automatically when you set up your Pulumi project. This is the main file where your infrastructure code goes in a Python Pulumi project.

Replace the existing content with the following code. Don't worry about understanding every line yet - we'll explain the key parts afterward:

```
"""A Pulumi program for UpCloud server deployment"""

import pulumi
from glob import glob
import os

import pulumi_upcloud as upcloud

# SSH key configuration
# Option 1: Automatically detect and use your local SSH key (set to False to disable)
use_local_ssh_key = True

# Option 2: Manually specify SSH keys (add one or more keys here)
manual_ssh_keys = [
    # "ssh-rsa AAAAB3Nz..c2Hys=",  # Uncomment and replace with your own key
    # "ssh-rsa AAAAB3Nz..c2B5Q==", # You can add multiple keys
]

# Collect SSH keys based on configuration
ssh_keys = []

# Add manually specified keys
ssh_keys.extend(manual_ssh_keys)

# Add local SSH key if enabled
if use_local_ssh_key:
    user_ssh_key_paths = glob(os.path.expanduser("~/.ssh/*.pub"))
    if user_ssh_key_paths:
        with open(user_ssh_key_paths[0]) as f:
            ssh_keys.append(f.read().strip())

# Make sure we have at least one SSH key
if not ssh_keys:
    raise Exception("No SSH public keys found! Either add a manual key or create one with 'ssh-keygen'")

# Create an UpCloud server
server = upcloud.Server("server",
    title= "Pulumi Server",
    hostname="pulumi.example.com",
    zone="de-fra1",
    plan="1xCPU-1GB",
    firewall=True,  # Enable firewall
    template=upcloud.ServerTemplateArgs(
        size=25,
        storage="01000000-0000-4000-8000-000030240200",
        title="Pulumi Server Device 1",
    ),
    # Configure both IPv4, IPv6 and utility network interfaces
    network_interfaces=[
        upcloud.ServerNetworkInterfaceArgs(
            type="public",
            ip_address_family="IPv4",
        ),
        upcloud.ServerNetworkInterfaceArgs(
            type="public",
            ip_address_family="IPv6",
        ),
        upcloud.ServerNetworkInterfaceArgs(type="utility")
    ],
    # Use SSH keys with root user
    login=upcloud.ServerLoginArgs(
        user="root",
        keys=ssh_keys,
        create_password=False,
    ),

    metadata=True,

    labels={
        "environment": "development",
        "managed-by": "pulumi"
    }
)

# Create firewall rules (allow SSH access)
firewall_rules = upcloud.ServerFirewallRules(
    "server-firewall",
    server_id=server.id,
    firewall_rules=[
        # Allow SSH access
        {
            "direction": "in",
            "family": "IPv4",
            "protocol": "tcp",
            "destination_port_start": "22",
            "destination_port_end": "22",
            "action": "accept",
        },
        # You can add more rules here as needed
    ],
)

# Export useful information
pulumi.export("server_id", server.id)
pulumi.export("hostname", server.hostname)
pulumi.export("public_ip", server.network_interfaces[0].ip_address)
pulumi.export("location", server.zone)
```

**SSH key configuration:** By default, the script will use your existing SSH public key (from ~/.ssh/) to allow you to connect to your server. You don't need to change anything here unless you want to use a different key.

**Server configuration:** The script creates a server with 1 CPU and 1GB RAM in Frankfurt, with both IPv4 and IPv6 addresses.

**Firewall rules:** The script sets up a firewall that only allows SSH connections (port 22) for security.

**Outputs:** At the end, the script exports useful information like the server's IP address that you'll need to connect to it.

Its worth taking a moment to review the code and familiarize yourself with its structure. You'll notice that most of the parameters are actually options that you would configure when creating a server through the UpCloud Control Panel - such as server plan, zone, os template, etc. The difference is that now these configurations are defined as code.

## Previewing your deployment

Before deploying, you should preview the changes that Pulumi will make:

```
pulumi preview
```

This will show you a plan of what resources will be created without actually deploying anything. It's similar to `terraform plan` if you're familiar with Terraform.

```
Previewing update (dev)

View in Browser (Ctrl+O): https://app.pulumi.com/username...

     Type                                  Name             Plan
 +   pulumi:pulumi:Stack                   upcloud-dev      create
 +   ├─ upcloud:index:Server               server           create
 +   └─ upcloud:index:ServerFirewallRules  server-firewall  create

Outputs:
    hostname : "pulumi.example.com"
    location : "de-fra1"
    public_ip: [unknown]
    server_id: [unknown]

Resources:
    + 3 to create
```

## Deploying your server

If the preview looks good, you can deploy your server with:

```
pulumi up
```

Pulumi will show you a preview of the changes and ask whether you would like to proceed:

```
Previewing update (dev)

View in Browser (Ctrl+O): https://app.pulumi.com/username...

     Type                                  Name             Plan
 +   pulumi:pulumi:Stack                   upcloud-dev      create
 +   ├─ upcloud:index:Server               server           create
 +   └─ upcloud:index:ServerFirewallRules  server-firewall  create

Outputs:
    hostname : "pulumi.example.com"
    location : "de-fra1"
    public_ip: [unknown]
    server_id: [unknown]

Resources:
    + 3 to create

Do you want to perform this update?  [Use arrows to move, type to filter]
> yes
  no
  details
```

Select "yes" to proceed with the deployment.

The deployment will take a few minutes to complete. When finished, Pulumi will display the outputs, including the server's IP address that we exported.

```
Updating (dev)

View in Browser (Ctrl+O): https://app.pulumi.com/username...

     Type                                  Name             Status
 +   pulumi:pulumi:Stack                   upcloud-dev      created (76s)
 +   ├─ upcloud:index:Server               server           created (66s)
 +   └─ upcloud:index:ServerFirewallRules  server-firewall  created (7s)

Outputs:
    hostname : "pulumi.example.com"
    location : "de-fra1"
    public_ip: "5.22.213.250"
    server_id: "0077945c-b262-4dd5-981f-b4c9575e9c48"

Resources:
    + 3 created

Duration: 1m10s
```

If you check the UpCloud Control Panel, you should see the newly deployed server in your account.

Sometimes Pulumi might say that a resource creation failed, but when you check your UpCloud control panel, you can see that the resource was actually created. This usually happens due to network issues or timeouts during the creation process. Refer to the [troubleshooting section](/docs/guides/get-started-pulumi#troubleshooting-common-issues.md) of this guide to see how to fix that.

## Managing your server

When you need to make changes to your infrastructure, simply update the Python code in your `__main__.py` file and apply the changes. Pulumi checks what has changed and creates an incremental execution plan to perform the updates.

For example, to increase the resources allocated to your server, open your `__main__.py` file in an editor and modify the plan. You can see the available preconfigured plans in your [UpCloud control panel](https://hub.upcloud.com/deploy).

```
# Create an UpCloud server
server = upcloud.Server("server",
    title= "Pulumi Server",
    hostname="pulumi.example.com",
    zone="de-fra1",
    plan="2xCPU-2GB", # --->  Changed from 1xCPU-1GB
    firewall=True,
    ...
```

Save the file with the changes, then type:

```
pulumi up
```

Pulumi will show a preview of the changes and ask for confirmation.

The `~` symbol indicates that resources will be updated rather than created. Now, apply the changes by selecting "yes" to proceed:

```
Updating (dev)

View in Browser (Ctrl+O): https://app.pulumi.com/username...

     Type                     Name          Status            Info
     pulumi:pulumi:Stack      upcloud-dev
 ~   └─ upcloud:index:Server  server        updated (63s)     [diff: ~plan]

Outputs:
    hostname : "pulumi.example.com"
    location : "de-fra1"
    public_ip: "5.22.213.250"
    server_id: "0077945c-b262-4dd5-981f-b4c9575e9c48"

Resources:
    ~ 1 updated
    2 unchanged

Duration: 1m7s
```

Pulumi will modify the server resources according to the differences between the server's current state and the new configuration.

In the same way, you could decrease the resources allocated to your cloud server by changing the plan back to `1xCPU-1GB`. However, note that this does not automatically resize the disk. While increasing disk size is straightforward, decreasing storage is not quite as simple. We recommend keeping your storage small if you wish to vertically scale the server and retain the preconfigured pricing.

## Destroying resources

In this guide, we've only deployed a single Cloud Server resource, which makes it safe and appropriate to use the `pulumi destroy` command to clean up everything at once. However, it's important to understand that in production environments, this command will delete all resources managed by your Pulumi stack - which could include more than one infrastructure resource.

When you are ready to remove the test server we created, you can delete it using:

```
pulumi destroy
```

Pulumi will show you a preview of what will be destroyed and ask for confirmation. Click yes to proceed:

The `-` symbol indicates that resources will be deleted. Check that the action about to be taken is correct and confirm by selecting "yes" to confirm the destruction:

```
Destroying (dev)

View in Browser (Ctrl+O): https://app.pulumi.com/username...

     Type                                  Name             Status
 -   pulumi:pulumi:Stack                   upcloud-dev      deleted (0.24s)
 -   ├─ upcloud:index:ServerFirewallRules  server-firewall  deleted (7s)
 -   └─ upcloud:index:Server               server           deleted (26s)

Outputs:
  - hostname : "pulumi.example.com"
  - location : "de-fra1"
  - public_ip: "5.22.213.250"
  - server_id: "0077945c-b262-4dd5-981f-b4c9575e9c48"

Resources:
    - 3 deleted

Duration: 36s

The resources in the stack have been deleted, but the history and configuration associated with the stack are still maintained.
If you want to remove the stack completely, run `pulumi stack rm mgmt`.
```

As explained previously, the destroy command will delete all resources configured in your Pulumi stack. In a production environment, instead of destroying everything, you would normally remove specific resources from your code and use `pulumi up` to update your infrastructure.

## Troubleshooting common issues

#### Failed but created resources

If Pulumi says that a resource creation failed, but you can see that the resource was actually created in the UpCloud Control Panel, don't worry. This usually happens due to network issues or timeouts during the creation process.

The output might look like this:

```
Updating (dev)

View in Browser (Ctrl+O): https://app.pulumi.com/username...

     Type                                  Name             Status
 +   pulumi:pulumi:Stack                   upcloud-dev      **failed**
 +   ├─ upcloud:index:Server               server           **creating failed**
 +   └─ upcloud:index:ServerFirewallRules  server-firewall  **creating failed**

Diagnostics:
  pulumi:pulumi:Stack (upcloud-dev):
    error: update failed

  upcloud:index:Server (server):
    error: Error while waiting for server to be in started state: Error: Get "https://api.upcloud.com/1.3/server/008ae63a-18a8-40b1-8ead-9c3e34e12e32": context deadline exceeded (Client.Timeout exceeded while awaiting headers)

Resources:
    1 unchanged

Duration: 2m41s
```

To fix this, you can import the existing resource into your Pulumi state using the following command:

```
pulumi import upcloud:index/server:Server <your-server-name> <server-uuid>
```

Replace `your-server-name` with the name you've given the server in your Pulumi code and `server-uuid` with the UUID of the server from your UpCloud control panel.

```
pulumi import upcloud:index/server:Server server 008ae63a-18a8-40b1-8ead-9c3e34e12e32
```

## Summary

Great job completing this guide! You now have the basic knowledge and resources to start building infrastructure on UpCloud with Pulumi. This is just an introduction to Pulumi using a single-file approach, which is perfect for getting started.

For advanced usage, refer to the official [Pulumi documentation](https://www.pulumi.com/docs/) and the [UpCloud Pulumi provider documentation](https://www.pulumi.com/registry/packages/upcloud/).
