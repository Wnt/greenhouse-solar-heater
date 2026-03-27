# How to set up and connect to UpCloud Managed Databases

UpCloud Managed Databases offers a hassle-free solution for database hosting at any scale. It allows users to deploy professional-grade database services on UpCloud without the need for manual installation.

By leveraging expert-managed cluster setups, users can enjoy huge advantages with minimal effort compared to the work required to deploy a similar system from scratch.

This guide will guide you through the process of effortlessly setting up Managed Databases and connecting your application to the database.

## Deploying Managed Database

The [UpCloud Managed Databases](https://upcloud.com/products/managed-databases/) are offered in 2 and 3-node clustered configurations with options to scale the services as needed with zero interruption. Unclustered single-node databases are also available which are great for testing and development before effortlessly scaling up to production.

To get started, go to your UpCloud Control Panel and find the Databases section in the main menu.

![UpCloud Managed Databases](img/image.png)

UpCloud Managed Databases

Deploy your first Managed Database by clicking the Create Database button. This will open up the database configuration options. Make the following selections according to your requirements.

- Select the location
- Choose your database type
- Pick your database plan
  - Select how many database nodes you want, 1-3
  - Select the resources for each node
- Check your connection access options
- Set your Allowed IP addresses
- Enter your database service name
- Enter hostname

Once finished, click the Create Database Service button to deploy!

![UpCloud Managed Database deploying](img/image-1.png)

UpCloud Managed Database deploying

Then sit back and relax while your new database service is built.

## Connecting to the Managed Database

Managed Databases offer a carefree approach to installation and management while still providing many of the same features as self-hosted databases. After deploying your first Managed Database, you are all set to begin using it like any other database with common database clients.

For this example, we are using the mycli command-line database client. Install the client on your computer or Cloud Server.

```
# Ubuntu and Debian
sudo apt install mycli
# CentOS
sudo yum install mycli
```

Using the client, you can easily connect to the Managed Database with the authentication details as shown in your UpCloud Control Panel.

```
mycli --user <username> --password=<password> --host <dbname-id>.db.upclouddatabases.com --port <port-number> <database-name>
```

You can also use the connection string which includes all the necessary authentication details. Below is an example of the connection string.

```
mycli mysql://upadmin:AVEh566_N73hfw7e@transactions-bohdgbdagtt.db.upclouddatabases.com:11550/defaultdb?ssl-mode=REQUIRED
```

Note that the Private connection is only available to Cloud Server which is connected to the Utility network and is located within the same data centre as the database. Also, if you’ve disabled the Allow all from the Utility network, you will need to add the Utility network IP address of your Cloud Server to the list of Allowed IP addresses.

For accessing the database from an external location, you will need to enable Public access to the database details. Remember to add your IP address to the list of Allowed IP addresses.

![Enabling public connection on UpCloud Managed Database](img/image-2.png)

Enabling public connection on UpCloud Managed Database

Then use the Connection string which includes the “public-” identifier in the database hostname.

```
mycli mysql://upadmin:AVEh566_N73hfw7e@public-transactions-bohdgbdagtt.db.upclouddatabases.com:11550/defaultdb?ssl-mode=REQUIRED
```

That’s all you need, you should now be connected to your Managed Database.

## Quick install WordPress on Cloud Server

A great benefit of utilising Managed Databases is how the database is run independently from the applications that use it. This approach allows you to make use of the high availability and scalability of the Managed Databases without worrying about downtime of your applications themselves.

In this example, we are deploying a WordPress website to demonstrate the process of connecting to the Managed Database. For this purpose, we will install a simple web server to run WordPress which will then utilise the Managed Database.

Deploy a new Cloud Server or use any existing server within the same zone as your Managed Database. Configure the server as you prefer, for example by using either Ubuntu or Debian operating system.

Once deployed, log in using SSH and install the following packages.

```
sudo apt install apache2 php8.2 php8.2-mysql php-common php8.2-cli php8.2-json php8.2-common php8.2-opcache libapache2-mod-php8.2
```

Then download the latest version of WordPress.

```
wget https://wordpress.org/latest.tar.gz -P $HOME/
```

Unpack the WordPress site, for example in */var/www/html* using the following command.

```
tar -zxvf $HOME/latest.tar.gz -C /var/www/html
```

Next, change the DocumentRoot in the Apache default configuration to point to the WordPress directory. The command below should handle that in one go.

```
sudo sed -i 's/html/html/wordpress/' /etc/apache2/sites-available/000-default.conf
```

Then update the file permissions to ensure the site will be accessible.

```
sudo find /var/www/html/wordpress -type d -exec chmod 755 {} ;
sudo find /var/www/html/wordpress -type f -exec chmod 644 {} ;
```

Afterwards, restart the webserver to apply all changes.

```
sudo systemctl restart apache2
```

With the web service side of our WordPress demo ready, continue in the next section on how to connect it with the Managed Database.

## Configuring WordPress to use the database service

Connecting an application to a Managed Database works just like with any self-hosted database. To do so, you first need to create a database for your application, WordPress in this example, and create a username with the required permissions.

Note that you should create separate users and databases for each application. To do so, you can use the mycli command-line client.

Connect to your database from a terminal, for example using the mycli tool and your connection string as displayed in your UpCloud Control Panel.

```
mycli mysql://upadmin:AVEh566_N73hfw7e@transactions-bohdgbdagtt.db.upclouddatabases.com:11550/defaultdb?ssl-mode=REQUIRED
```

Once connected, you will be greeted by the default database command prompt.

Create a new database by the name `wordpress`.

```
CREATE DATABASE wordpress;
```

Create a new username defined by the Utility network IP address of your Cloud Server that is hosting your WordPress instance.

```
CREATE USER 'wordpress'@'<utility-ip-address>' IDENTIFIED BY '<password>';
```

Then grant the `wordpress` user all permissions to the new database. Make sure to include the Utility IP address in the user details to restrict access to the database solely for your own Cloud Server.

```
GRANT ALL ON wordpress.* TO 'wordpress'@'<utility-ip-address>';
```

Lastly, flush the grant table to make the changes take effect.

```
FLUSH PRIVILEGES;
```

When done, exit the database command prompt and close the connecting.

```
EXIT;
```

You should now be able to connect to the new database table with the user you just created.

```
mycli --user wordpress --password=<password> --host <dbname>.db.upclouddatabases.com --port <port-number> wordpress
```

Lastly, configure the same database connection details on your WordPress instance by setting up the wp-config.php file by making a copy of the sample and then editing it as indicated below.

```
cp /var/www/html/wordpress/wp-config-sample.php /var/www/html/wordpress/wp-config.php
nano /var/www/html/wordpress/wp-config.php
```

Set the database and username as shown below and replace the `<password>`, `<hostname>` and `<port-number>` with your own.

```
// ** MySQL settings - You can get this info from your web host ** //
/** The name of the database for WordPress */
define( 'DB_NAME', 'wordpress' );

/** MySQL database username */
define( 'DB_USER', 'wordpress' );

/** MySQL database password */
define( 'DB_PASSWORD', '<password>' );

/** MySQL hostname */
define( 'DB_HOST', '<hostname>.db.upclouddatabases.com:<port-number>' );
```

When done, save the file and exit the editor.

You should now be able to take WordPress through its initial setup. Open the public IP address of your Cloud Server on your web browser to check. You should see the following configuration screen.

![WordPress deployment using UpCloud Managed Database](img/image-3.png)

WordPress deployment using UpCloud Managed Database

## Summary

Connecting your application or service after setting up UpCloud Managed Databases is as easy as one, two, three! With quick deployment, you can easily begin developing your next idea without a single worry about maintenance. And when you are ready to unveil your creation, zero-downtime scalability will help you take it to the next level!

If you want to learn more, check out our documentation for Managed [MySQL](/docs/products.md), [Managed OpenSearch](/docs/products/managed-opensearch.md), [Managed PostgreSQL](/docs/products/managed-postgresql.md), or [Managed Valkey](/docs/products/managed-valkey.md).
