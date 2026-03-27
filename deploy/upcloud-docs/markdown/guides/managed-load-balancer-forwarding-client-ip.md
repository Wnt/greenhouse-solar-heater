# Forwarding client IP address on Managed Load Balancer

When working with load balancers and backend servers, it's important to understand how client IP addresses are handled. By default, many load balancers do not forward the actual client IP addresses to the backend servers. Instead, the backend servers only see the private IP address of the load balancer itself.

This behaviour can be problematic in certain scenarios, such as:

1. **Logging and Monitoring**: If you need to track requests from individual clients for logging, debugging, or security purposes, not having the actual client IP addresses on the backend servers can make this difficult or impossible.
2. **Geolocation and Content Personalisation**: If your application needs to serve different content or experiences based on the client's geographic location or other client-specific factors, not having the real client IP addresses can prevent this functionality from working correctly.
3. **Security and Access Control**: Some applications may need to allow or deny access based on the client's IP address for security reasons. Without the actual client IP addresses, this becomes challenging to implement.

To address these situations, load balancers often provide a mechanism to enable client IP address forwarding or preservation. By configuring this feature, the load balancer can pass along the actual client IP addresses to the backend servers, allowing them to access this information.

Understanding and properly configuring client IP address forwarding is an important aspect of load balancer setup and management, especially in scenarios where you need to maintain visibility into the original client IP addresses on your backend servers.

This guide will walk you through the process of enabling client IP forwarding with an UpCloud Load Balancer and setting up your backend servers to receive this information.

What you will need for this guide:

- An UpCloud Load Balancer.
- A web server (Apache or Nginx).
- A private SDN network.

## Configure the UpCloud Load Balancer

On the UpCloud Control Panel, navigate to the Load Balancer’s service page. Select your Load Balancer, then select the Frontends tab.

1. Create a new frontend.
   Set the Load Balancer frontend to HTTP mode. This is required for inspecting and manipulating HTTP headers, like the 'X-Forwarded' headers.

   ![](image.png)
2. Add a Frontend rule for X-Forwarded headers.

   ![](image-1.png)

This rule will add 'X-Forwarded-For', 'X-Forwarded-Proto', and 'X-Forwarded-Port' headers to each request, meaning backend servers will receive detailed client request information, such as IP address, protocol, and port number.

After configuring the load balancer to forward the client IP addresses, the next step is to configure the web servers to recognise and log these IP addresses correctly. This allows us to verify that the IP forwarding is working as expected. In the next section, we'll configure Apache and Nginx to use the forwarded IP addresses for logging.

### Configuring Apache2

On the server, update the webserver config file. The configuration file is usually named after the website or virtual host it corresponds to, and has a `.conf` extension. You can find this file in the `/etc/apache2/sites-available/` directory.

```
<VirtualHost *:80>
	...
RemoteIPHeader X-Forwarded-For
...
</VirtualHost>
```

Enable the Remote IP module.

```
sudo a2enmod remoteip
```

Test the changes:

```
sudo apache2ctl configtest
```

Restart Apache:

```
sudo systemctl restart apache2
```

You should now get the client’s real IP address. You can verify this by viewing your server’s `/var/log/apache2/access.log` file.

### Configuring Nginx

Update the webserver config file on the server. The configuration file is usually named after the website or server block it corresponds to and has a `.conf` extension. You can find this file in the `/etc/nginx/sites-available/` directory.

```
server {
	root /var/www/html;

	index index.html index.htm index.nginx-debian.html;

	server_name _;

	location / {

		try_files $uri $uri/ =404;
	}

set_real_ip_from   10.0.1.0/24; # Your private SDN
real_ip_header     X-Forwarded-For;
}
```

Testing the changes:

```
sudo nginx -t
```

Restarting Nginx:

```
sudo systemctl restart nginx
```

You should now get the client’s public IP address. You can verify this by viewing your server’s `/var/log/nginx/access.log` file.
