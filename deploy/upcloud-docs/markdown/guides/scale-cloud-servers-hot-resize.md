# Scaling Cloud Servers without downtime using Hot Resize

Vertically scaling Cloud Servers is a convenient way to increase resources as your requirements grow. However, making changes to your server configuration usually requires a shutdown which in turn causes downtime to your services. Not so on UpCloud, introducing hot resize!

Hot resize on UpCloud allows you to increase your Cloud Server resources while running. The feature is automatically enabled on Cloud Servers created on or after April 27th 2022. Servers created before this date require a single shutdown and restart for hot resizing to become available.

The storage device or devices attached to the Cloud Server being resized are not automatically increased. This allows you to also easily scale down to your previous server plan if needed. Note that decreasing Cloud Server resources still requires the server to be shut down.

Hot resizing is available via your UpCloud Control Panel at [hub.upcloud.com](https://hub.upcloud.com) and by using the [server modify API endpoint](https://developers.upcloud.com/1.3/8-servers/#modify-server) provided by the UpCloud API.

## Hot resize via UpCloud Control Panel

The easiest way to hot resize your Cloud Server is by using the simple and intuitive UpCloud Control Panel at [hub.upcloud.com](https://hub.upcloud.com)

Select the Cloud Server you wish to scale up and go to the *Plan* tab.

![cloud server plans](img/cloud-server-plans-2.png)

Next, choose the new General Purpose plan you want to scale up to.

![hot resize cloud server](img/hot-resize-cloud-server-2.png)

When ready, click the Save changes button at the bottom of the page to apply the new plan.

![resize success](img/resize-success-2.png)

Once the changes have been applied, you will get a notification to confirm the plan has been updated.

Notice that the storage device is not resized automatically. This is done to allow you to scale down to your previous plan if required. If you are going to stay with the new plan and want to take advantage of the additional storage space, you can increase your storage following [this guide](/docs/guides/increasing-storage-size.md).

## Hot resizing using the UpCloud API

The fully featured UpCloud API allows you to perform all the same operations as are available through the UpCloud Control Panel and then some. If you are new to using our API, check out our [getting started guide](/docs/guides/getting-started-upcloud-api.md) to learn the basics.

Hot resizing a Cloud Server using the UpCloud API requires but one API request.

For example, a server running the 1xCPU-1GB General Purpose plan can be upgraded to a higher configuration with the following command. Replace the server\_UUID with the actual unique identification code matching your Cloud Server.

PUT /1.3/server/server\_UUID

Then include the new desired General Purpose plan in the request body in JSON format.

```
{
    "server" : {
       "plan" : "2xCPU-4GB"
    }
}
```

A list of available General Purpose Plans can be requested from [this API endpoint](https://developers.upcloud.com/1.3/7-plans/)

When you send the API request, the system will confirm that the server can be scaled up and then applies the changes. If everything is in order, you will receive the following HTTP response:

```
202 Accepted
```

The Cloud Server resources are then increased to the target values while the server is running.

## Additional details

Hot resizing system memory is done using virtual memory slots. Each Cloud Server has a fixed number of memory slots. Every time memory is added using hot resized, these slots are used to include the added amount of memory.

If all slots are already in use, system memory cannot be increased using hot resize until the server is shut down and started. After a full restart, allocated system memory is consolidated and the slots are freed for further hot resizing.

It's possible that your Cloud Server's operating system doesn't bring all hot resized cores online automatically.

You can check the currently available CPU count with the following command on Linux systems.

```
lscpu
```

Or press `CTRL+SHIFT+ESC` on Windows systems to open the Windows Task Manager.

The easiest way to fix this is to reboot the server. However, on Linux systems, you can use the following script to try to bring CPUs online without a shutdown.

Copy the following to a new file in a text editor, for example as a file called *update-cpu.sh*.

```
#!/bin/bash
for CPU_DIR in /sys/devices/system/cpu/cpu[0-9]*
  do
      CPU=${CPU_DIR##*/}
      CPU_STATE_FILE="${CPU_DIR}/online"
      if [ -f "${CPU_STATE_FILE}" ]; then
            if grep -qx 0 "${CPU_STATE_FILE}"; then
                  echo 1 > "${CPU_STATE_FILE}"
            fi
      fi
  done
```

Save the file and make it executable.

```
chmod +x update-cpu.sh
```

Then run the script by calling it on the command line.

```
./update-cpu.sh
```

You should then be able to see all allocated CPU cores. If not, proceed to reboot your Cloud Server.
