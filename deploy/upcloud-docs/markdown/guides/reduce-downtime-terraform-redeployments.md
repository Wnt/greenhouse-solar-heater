# How to reduce downtime in Terraform redeployments

Managing cloud infrastructure using [Terraform](https://www.terraform.io/) has become a de facto standard, and it certainly makes managing our complex cloud platform easier. However, it doesn’t come without challenges. Anyone that has deployed changes to live infrastructure has likely experienced extended application downtime while resources are being replaced. Thankfully we can employ a few features in Terraform that can reduce downtime and increase the availability of managed resources.

In this post, we will use UpCloud’s cloud platform along with their [Terraform provider](https://registry.terraform.io/providers/UpCloudLtd/upcloud/latest) and the [upctl](/docs/tooling/cli.md) command-line tools to demonstrate what you can do to minimise interruptions to your services when making changes to your cloud infrastructure.

In this blog post, we will cover:

- Using UpCloud’s Floating IPs to ensure a server has a consistent IP address.
- Using Terraform’s lifecycle configuration to change the order in which our resources are created and destroyed, meaning that our new resource is created before the old one is destroyed, reducing our downtime.
- Using a local-exec provisioner to check that our resource is ready for traffic before we go ahead and destroy the old one.

With these configurations in place, we will be able to make changes to the core parts of our infrastructure with certainty that the new pieces will become available with minimal downtime to Terraform managed resources.

## Prerequisites

The steps demonstrated in this tutorial are made intentionally generic to keep the examples simple. This is done to allow anyone with even just a passing knowledge of Terraform to follow along. The only requirements are to have a working installation of [Terraform](/docs/guides/get-started-terraform.md) and [upctl](/docs/guides/get-started-upcloud-command-line-interface.md) on your local computer.

Check out their respective started tutorials to learn more if you haven’t used these before.

## Initial state

Downtime can happen to any resources managed by Terraform and occurs when a change requires the resource to be destroyed and a new resource created in its place. A common example of this is changing the machine image or boot disk of a Cloud Server.

To start with, we need to have some cloud resources that’ll simulate our web application. Our initial Terraform configuration is as follows:

```
resource "upcloud_server" "app" {
  hostname = "myapplication.com"
  zone     = "uk-lon1"
  plan     = "1xCPU-1GB"

  template {
    storage = "Ubuntu Server 20.04 LTS (Focal Fossa)"
    size    = 25
  }

  network_interface {
    type = "public"
  }

  user_data = &lt;&lt;-EOF apt-get update apt-get -y install apache2 jq echo '(1.0) Hello!' &gt; /var/www/html
    systemctl restart apache2
  EOF
}
```

We are just deploying a fresh Ubuntu 20.04 Cloud Server with a public IP. Additionally, we are installing Apache2 and creating a simple index page to have something to query against.

You should include login credentials in your deployment if you wish to access the server. However, for this tutorial, we are going to perform all operations on the local command line.

```
  login {
    user            = "root"
    keys            = [ "ssh-rsa key" ]
    create_password = false
  }
```

If we deploy our code and configuration at this point, we would expect it to all deploy nicely. We can determine the IP address of our server by using the upctl CLI tool. Note that calling the server resources by their hostname only works when the hostname is unique on your UpCloud account:

```
upctl server show myapplication.com
```

```
  Common
    UUID:          0099b58a-c5f5-4a39-b63e-f6120d701f74
    Hostname:      myapplication.com
    Title:         myapplication.com (managed by terraform)
    Plan:          1xCPU-1GB
    Zone:          uk-lon1
    State:         started
    Simple Backup: no
    Licence:       0
    Metadata:      True
    Timezone:      UTC
    Host ID:       5767971459
    Tags:

  Storage: (Flags: B = bootdisk, P = part of plan)

     UUID                                   Title                              Type   Address   Size (GiB)   Flags
    ────────────────────────────────────── ────────────────────────────────── ────── ───────── ──────────── ───────
     01bda3be-ad76-44d3-afc8-fe3d2489ae57   terraform-myapplication.com-disk   disk   ide:0:0           25   P

  NICs: (Flags: S = source IP filtering, B = bootable)

     #   Type     IP Address                 MAC Address         Network                                Flags
    ─── ──────── ────────────────────────── ─────────────────── ────────────────────────────────────── ───────
     1   public   IPv4: 94.237.121.69        ee:1b:db:ca:61:ee   03000000-0000-4000-8100-000000000000   S
```

Next, by using curl to query that endpoint we should get the following response:

```
$ curl http://94.237.121.69
(1.0) Hello!
```

Now, let’s update our Terraform configuration, for example, by changing the contents of the index.md.

```
resource "upcloud_server" "app" {
  hostname = "myapplication.com"
  ...

  user_data = <<-EOF
    apt-get update
    apt-get -y install apache2 jq
    echo '(2.0) Hello again!' > /var/www/html
    systemctl restart apache2
  EOF
}
```

If we then apply the changes, Terraform will recognise the difference and require the Cloud Server to be recreated. This will cause Terraform to destroy our existing server and create a new one.

```
Terraform will perform the following actions:

  # upcloud_server.app must be replaced
+/- resource "upcloud_server" "app" {
      ~ cpu       = 1 -> (known after apply)
      - firewall  = false -> null
      ~ id        = "00980377-5a6e-4b1f-90ba-fe73bf68ca6e" -> (known after apply)
      ~ mem       = 1024 -> (known after apply)
      - metadata  = false -> null
      - tags      = [] -> null
      ~ title     = "myapplication.com (managed by terraform)" -> (known after apply)
      ~ user_data = <<-EOT # forces replacement
            apt-get update
            apt-get -y install apache2 jq
          - echo '(1.0) Hello!' > /var/www/html
          + echo '(2.0) Hello again!' > /var/www/html
            systemctl restart apache2
        EOT
```

Go ahead and hit apply to see for yourself.

Once Terraform gets to work, we’ll discover that our service has become inaccessible as the first instance is destroyed.

```
upcloud_server.app: Destroying... [id=00980377-5a6e-4b1f-90ba-fe73bf68ca6e]
upcloud_server.app: Still destroying... [id=00980377-5a6e-4b1f-90ba-fe73bf68ca6e, 10s elapsed]
upcloud_server.app: Destruction complete after 11s
upcloud_server.app: Creating...
upcloud_server.app: Still creating... [10s elapsed]
upcloud_server.app: Still creating... [20s elapsed]
upcloud_server.app: Creation complete after 27s [id=00d512f8-9bf4-4f11-8d4e-3c56011c83a3]
```

Since our web server is a very simple example, it doesn’t take long to initialise. However, even then, our service might be down for more than a minute. Let’s change that!

## Adding Floating IP

In addition to the Terraform operations taking time, it’s also possible our services never come up again on the same endpoint. A common reason why redeployment may result in extended downtime is that the public IP address of the new server is different from the old IP.

The IP addresses assigned to your Cloud Servers are given at random. While you may get the same IP address between server to destroy/create cycles, it isn’t guaranteed. To overcome this in our effort to reduce downtime in our Terraform deployments we will use [UpCloud’s Floating IP](/docs/guides/floating-ip-addresses.md) facility.

We will add a new resource using `upcloud_floating_ip_address` to our Terraform configuration. Simply add the following to the end of your Terraform configuration file:

```
resource "upcloud_floating_ip_address" "app_ip" {
  mac_address = upcloud_server.app.network_interface[0].mac_address
}
```

This resource will assign a public IPv4 address to our server’s network interface as identified by the `mac_address` value. As of today, this isn’t quite enough as the metadata service, UpCloud provided web service that allows a server to query data about itself, doesn’t refresh automatically. As a workaround, we can turn the metadata service off and on again by using a Terraform `null_resource` and calling `upctl`:

```
resource "null_resource" "metadata_update" {

  triggers = {
    mac_address = upcloud_floating_ip_address.app_ip.mac_address
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command = <<-EOF
      upctl server modify ${upcloud_server.app.id} --disable-metadata
      upctl server modify ${upcloud_server.app.id} --enable-metadata
    EOF
  }
}
```

This null\_resource is triggered by any change to the associated `upcloud_floating_ip_address.mac_address` value. For example, when assigning the IP to a new Cloud Server. Once triggered, it uses a local-exec provisioner to run a small bash script on the machine performing the deployment.

This script uses upctl to turn off the metadata service and then turn it back on again.

To use the floating IP address, we need to make the Linux operating system aware of it. You can find an example of automating this here:

- [floating\_ip.sh](https://github.com/opencredo/upcloudtfdowntime/blob/main/packer/artefact/floating_ip.sh) – A shell script that pings the metadata service looking for a floating IP. If it already has a floating IP, this script does nothing.
- [floating\_ip.service](https://github.com/opencredo/upcloudtfdowntime/blob/main/packer/artefact/floating_ip.service) – A systemd unit that runs the above script as a one-shot, i.e. once per boot.

We can update our server to use the above files by adding the following to our `user_data` script.

```
resource "upcloud_server" "app" {
  hostname = "myapplication.com"
  ...
  user_data = <<-EOF apt-get update apt-get -y install apache2 jq echo '(2.0) Hello again!' > /var/www/html
    systemctl restart apache2

    wget https://raw.githubusercontent.com/opencredo/upcloudtfdowntime/main/packer/artefact/floating_ip.sh -O /usr/local/bin/floating_ip.sh
    chmod +x /usr/local/bin/floating_ip.sh
    wget https://raw.githubusercontent.com/opencredo/upcloudtfdowntime/main/packer/artefact/floating_ip.service -O /lib/systemd/system/floating_ip.service
    systemctl daemon-reload
    echo 'source /etc/network/interfaces.d/*' >> /etc/network/interfaces
    systemctl start floating_ip
  EOF
```

Afterwards, re-deploy the resources again using Terraform. We will then see a new floating IP created.

If we were to cause the server to be redeployed, for example by tainting it, we would see our endpoint go down and approximately a minute later come back up again at the same IP address.

## Configuring resource lifecycle

Having recreated our Terraform resources already a few times, we have a good idea of the time it takes for Terraform to apply changes. In the Terraform output, we can see the following:

```
upcloud_server.app: Destroying... [id=00379689-3649-403f-b639-50c8d2a7309b]
upcloud_server.app: Still destroying... [id=00379689-3649-403f-b639-50c8d2a7309b, 10s elapsed]
upcloud_server.app: Destruction complete after 16s
upcloud_server.app: Creating...
upcloud_server.app: Still creating... [10s elapsed]
upcloud_server.app: Still creating... [20s elapsed]
upcloud_server.app: Still creating... [30s elapsed]
upcloud_server.app: Creation complete after 34s [id=00953906-2578-4f3a-b790-cae1e62001bb]
```

The terminal output shows the old server’s destruction before the new server is created, which is the bulk of our downtime. We can mitigate this by using Terraform’s [lifecycle block](https://www.terraform.io/docs/language/meta-arguments/lifecycle.md) that tells Terraform to create the new server before it destroys the old one.

This configuration is available on all Terraform resources, but you should consider if it is needed as it adds complexity and maybe be difficult to troubleshoot. Some resources may need to destroy their old version first to free up a dependency.

In our case, the lifecycle condition will be useful. Let’s add this block to the `upcloud_server` resource in our Terraform configuration:

```
resource "upcloud_server" "app" {
  hostname = "myapplication.com"
  ...

  lifecycle {
    create_before_destroy = true
  }
  ...
}
```

That should be all we need to do to reduce downtime in our Terraform redeployments

If we were to cause our server to be replaced, maybe by updating the `user_data` section again, we would see our endpoint go down. It will take longer for the endpoint to go down this time, and it only takes around 5 seconds for it to come back up again.

We can retake a look at the logs:

```
upcloud_server.app: Creating...
upcloud_server.app: Still creating... [10s elapsed]
upcloud_server.app: Still creating... [20s elapsed]
upcloud_server.app: Creation complete after 27s [id=00ae5717-2ead-4c68-9339-1c737f5b0678]
```

And then later in the logs:

```
upcloud_server.app (deposed object 14b4d5c5): Destroying... [id=007c66bc-4c9a-4e18-a2d5-d82d1c3fe483]
upcloud_server.app: Still destroying... [id=007c66bc-4c9a-4e18-a2d5-d82d1c3fe483, 10s elapsed]
upcloud_server.app: Destruction complete after 11s
```

We can see the new Cloud Server being created first before the destruction of the old one. At this point, we’ve reduced the redeployment downtime to but a few seconds. However, eliminating the last few seconds of downtime would require tweaking our infrastructure and introducing something like a reverse proxy or a load balancer. Because those last seconds are due to the time it takes for the floating IP to be reassigned.

## Protecting against failed deployments

We’ve now managed to reduce downtime caused by Terraform redeployments considerably! However, there’s still one additional problem we need to consider. What if the new version of our service fails upon deployment or it returns an error for a period after the initial startup? For example, it may take some time for a database connection to be established. Is it possible to protect against that scenario?

Yes! In essence, we would want Terraform to check the health of our new `upcloud_server` resource before it goes ahead and destroys the old instance and flips the floating IP over to our new server.

We can use the local-exec provisioner to do this again.

We add the following to the terraform file:

```
resource "upcloud_server" "app" {
  hostname = "myapplication.com"
  ...

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]

    command = <<-EOF fail_count=0 while true; do response=$(curl --write-out %%{http_code} --silent --output /dev/null http://${self.network_interface[0].ip_address}) echo "Response: $response" if [[ "$response" == "200" ]]; then echo "Application is available" exit 0 fi fail_count=$((fail_count + 1)) if (( fail_count > 30 )); then
          echo "Application is still unavailable"
          exit 2
        fi

        echo "Sleeping"
        sleep 10
      done
    EOF
  }
}
```

This local-exec provisioner calls a short bash script that uses curl query on the new server. We can figure out the state of the services by checking the HTTP response when accessing the new `upcloud\_server` resource via its IP address `self.network\_interface\[0\].ip\_address`. If the response is 200, then the new resource is considered available, and the Terraform apply can continue. It will attempt to probe the endpoint for 5 minutes (30 fails \* 10s sleep per loop) and, if it is still not up during this period, it will fail.

This failure will leave the old infrastructure untouched, but the failed `upcloud_server` resource will not be cleared up. A future Terraform apply with a fix will tidy it up.

To test this, we can make another change to our deployment. This time, let’s add a sleep command that purposefully increases the time for the services to become available.

```
  user_data = <<-EOF
    apt-get update
    sleep 60
    apt-get -y install apache2 jq
    echo '(2.0) Hello again!' > /var/www/html
    systemctl restart apache2
```

If we deploy this, we should see the deployment now takes much longer. However, there should still only be a few seconds of downtime.

We can examine the Terraform logs to see this in action:

```
upcloud_server.app: Provisioning with 'local-exec'...
upcloud_server.app (local-exec): Executing: ["/bin/bash" "-c" "fail_count=0 nwhile true; do n  response=$(curl --write-out %{http_code} --silent --output /dev/null http://94.237.61.152) n  echo "Response: $response" n      n  if [[ "$response" == "200" ]]; then n    echo "Application is available"n    exit 0 n  fi n        n  fail_count=$((fail_count + 1))n        n  if (( fail_count &gt; 30 )); thenn    echo "Application is still unavailable"n    exit 2n  finn  echo "Sleeping"n  sleep 10ndonen"]
upcloud_server.app: Still creating... [40s elapsed]
upcloud_server.app (local-exec): Response: 000
upcloud_server.app (local-exec): Sleeping
```

We can see the creation of the new server resource and, we can also see our local-exec provisioner starting and getting error responses from the server. Later in the log (after our 2 minutes), we can see:

```
upcloud_server.app: Still creating... [2m0s elapsed]
upcloud_server.app (local-exec): Response: 200
upcloud_server.app (local-exec): Application is available
upcloud_server.app: Creation complete after 2m9s [id=00bb0b8e-7a62-44bc-a34a-95ef0e50529d]
```

We can see the local-exec provisioner receiving a 200 response which completes the new server resource creation. The rest of the Terraform apply can then continue, and we will see our latest version come up.

## Conclusion

Congratulations! You should now have a few tricks up your sleeve to reduce downtime in your Terraform deployments.

For something more to learn about, check out our practical demonstration incorporating Terraform cloud, a GitHub Actions continuous deployment pipeline and Packer over at YouTube:

The code demonstrating the concepts in the video and this blog post is available on [GitHub](https://github.com/opencredo/upcloudtfdowntime).

If a further blog post or video with an in-depth look at any of the concepts covered here is of interest, please leave a comment on the video or get in touch.
