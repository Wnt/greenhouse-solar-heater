# Initialization Scripts

Newly deployed cloud servers usually require some steps to set up. Everyone has their own list of things to go through from adding new user accounts to running updates and installing common applications. With *Initialization scripts* , you can automate the tasks you would otherwise perform again and again when booting up a new host.

![Initialization scripts](img/initialization-scripts-2.png)

## Adding scripts

You can manage your scripts with the Initialization Scripts feature in your UpCloud Control Panel under your Account section. Click the *Add new* button at the top of the page to open the editor window.

![Add initialization script](img/add-initialization-script.png)

Copy any pre-existing script you might have into the script text field, or write a new script straight in the browser. Name your scripts so that you can easily distinguish between them. Once you are done, click the *Update script* button at the bottom to save the changes.

## Deploying with a script

The Initialization scripts are supported by all of our public Linux templates. After adding any [SSH keys](/docs/guides/managing-ssh-keys.md) you may wish to use, you can find the option to load your previously saved initialization scripts.

Selecting one of your stored scripts will bring it to the edit field below. You can make any last-minute changes to the script still before deployment, or you can write a completely new script right on the spot. Once you are done making changes, click the *Create* button as usual to deploy the new server. The server will perform the actions dictated by the script during the first boot up saving you considerable time and effort.

![Using initialization script at deployment](img/use-initialization-script.png)

Testing new initialization scripts is also easy thanks to the extremely fast deployment to any of the UpCloud availability zones. If your script didn’t perform as expected, you can always delete the server and deploy it again. Iterating your scripts will let you fine-tune the tasks at boot up and be running again within seconds.

## Writing scripts

Initialization scripts support anything a regular Linux shell script would. Depending on your choice of distribution, the default shell might use different implementations, but the principles remain the same. Below is an example of how to have the server automatically run the update and upgrade routines as also seen in the picture above.

```
#!/bin/bash
# Run the commands in a noninteractive mode
export DEBIAN_FRONTEND=noninteractive
# Update source list and log the output to file
apt-get update > /tmp/init-script.log
# Upgrade available software packages with default options when available
apt-get -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" -y upgrade >> /temp/init-script.log
```

Certain OS versions can use a separate script format with a setup file [\_cloud-config\_](https://cloudinit.readthedocs.io/en/latest/topics/examples.md). The config file is read at boot, which allows a new node e.g. to be automatically updated and restarted.

```
#cloud-config
coreos:
  update:
    reboot-strategy: "reboot"
users:
  - name: "elroy"
    passwd: "$6$5s2u6/jR$un0AvWnqilcgaNB3Mkxd5yYv6mTlWfOoCYHZmfi3LDKVltj.E8XNKEcwWm..."
    groups:
      - "sudo"
      - "docker"
    ssh-authorized-keys:
      - "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0g+ZTxC7weoIJLUafOgrm+h..."
```

It is also possible to enter a URL in an initialization script. If the script contains an address, the deployment process will attempt to fetch the script and use it instead. This allows greater flexibility including dynamically updating the initialization script between deployments.
