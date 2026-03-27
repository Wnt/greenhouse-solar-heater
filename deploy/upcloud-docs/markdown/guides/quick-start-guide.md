# Cloud Server quick start guide

Cloud servers offer on-demand availability of computer system resources, including data storage and computational capacity, without needing to manage the server hardware directly. UpCloud users can deploy Cloud Servers by selecting from the predefined configuration options: Developer, General Purpose, High CPU and High Memory or Cloud Native plans.

Whether you're new to cloud computing or an experienced developer, these step-by-step instructions will help you get your server online swiftly and securely. Follow along to learn how to deploy a new server, connect to it, and start utilising the power of UpCloud.

## Deploying a Cloud Server

1. **Navigate to the dashboard** and locate the purple 'Deploy' button in the top right corner. Click on it and select 'Server'.
2. **Select the server location**: Choose the physical location of your server. For reduced latency, choosing the location closest to you is advisable.
3. **Choose a plan**: Select a preconfigured plan from Developer, General Purpose, High CPU, High Memory and Cloud Native.
4. **Configure storage**:

   - A Developer or General Purpose plan automatically configures a storage device based on the chosen plan. This device's storage size is fixed, but you can add up to 15 additional storage devices (16 in total), each up to 4 TB.
   - For a Cloud Native plan, specify the exact storage specifications to meet your needs.
5. **Automated backups**: Enable this feature and choose a backup plan (Day, Week, Month, or Year). Note: The Day plan is included at no extra cost if automated backups are enabled.
6. **Choose an OS template**: Select a public template with common server OS options.
7. **Login method**: Decide your preferred login method for the server - SSH keys or a one-time password.
8. **Set hostname and server name**: Assign a fully qualified domain name as your server's hostname. Also, give your server a name for easy identification within the control panel.
9. **Deploy the server**: Click the 'Deploy' button to begin the server creation process.

Detailed instructions for deploying a cloud server can be found in our guide on [Deploying a new cloud server](/docs/guides/deploy-server.md).

## Connecting to your Cloud Server

To establish a connection to your cloud server from a Linux, macOS, or Windows Subsystem for Linux (WSL) environment using a terminal:

1. **Initiate the SSH connection**: Open your terminal application, and enter the following command `ssh [email protected]`

> Replace '94.123.45.67' with your server's IP address and 'username' with your server username. In most cases, the username is root. After modifying the command, press `enter`.

2. **First-time authentication**: If this is your first time connecting to the server, you may encounter a message about the host's authenticity. Verify that the IP address mentioned is identical to your server's. If the details are correct, type "yes" and press `enter`.

If the server was configured without SSH keys, you'll be prompted to enter your password instead.

> It is normal for the password characters not to appear on the screen; this is a security feature. Type or paste your password anyway and press `enter` to proceed.

Windows users can connect with [PuTTY](/docs/guides/connecting-to-your-server#putty.md).

Detailed instructions for connecting to your cloud server can be found in our guide on [Connecting to your cloud server](/docs/guides/connecting-to-your-server.md).

## Deleting to your Cloud Server

1. **Stop the server**: Navigate to your server's [overview page](/docs/guides/managing-servers#server-overview.md) in the control panel. If the server status is 'Started', click the 'Shut down' button to initiate a shutdown.
2. **Delete the server**: Once the server is stopped, click on the small downward arrow next to the 'Start' button. From the dropdown menu, select the 'Delete' option.
3. **Confirm deletion**: This action is irreversible, and all data on the server will be permanently deleted. Confirm the deletion if you are sure you want to proceed.

After confirming the deletion, the server will be removed from your control panel, and all associated resources will be released. From this point on, you will not incur any further charges for the server.
