# How to migrate MySQL DB to UpCloud Managed Databases

Migrating computer services is always a daunting task and moving over databases with business-critical data can be doubly so. However, with just a few simple steps, you can safely migrate a MySQL database to UpCloud Managed Databases.

Moving your MySQL databases to Managed Databases will take away the need for manual maintenance. In this guide, we’ll show you the tools, steps and requirements to make the migration easy and painless.

## Pre-requisites to migrating MySQL

### 1. New Managed Database

Start by setting up a new [Managed Database cluster](/docs/guides/set-up-upcloud-managed-databases.md) you are migrating into. You will need to choose a plan with enough storage capacity for your existing database.

### 2. Host for the migration

You will also need a host system that can facilitate the migration. While in principle, you could export your database on almost any computer, the storage capacity and network speeds might make it impractical in most cases.

Managed Databases perform the best by serving a Cloud Server over a Private network within the same data centre which will make importing much quicker.

[Create a new Cloud Server](/docs/guides/deploy-server.md) to export and import your MySQL database.

### 3. Database tools

Once you have a Cloud Server up and running, you are almost ready to start migrating. However, you still need to install the tools that will do the heavy lifting.

[Mysqldump](https://dev.mysql.com/doc/refman/8.0/en/mysqlpump.md) is a common MySQL client utility and database backup program that performs logical backups. It is used to produce a set of SQL statements that when executed will reproduce the original database object definitions and table data. It can be used to dump one or more MySQL databases for backup or to migrate to a new SQL server.

[MySQL client](https://dev.mysql.com/doc/refman/8.0/en/mysql.md) is a popular command-line tool for manual input editing capabilities. In addition to offering interactive query options, the MySQL client can be used to import the data dump into the new Managed Database.

You can install both of these with one of the following commands.

```
# Debian or Ubuntu
sudo apt install mysql-client

# CentOS
sudo dnf install mysql-client
```

Additionally, it’s important to note that the migration steps will take some time, especially with larger databases. And while mysqldump includes verbose output options, MySQL client doesn’t provide progress status. Therefore, before starting the migration, you should install a pipe viewer which can be used to keep tabs on the transfer processes.

```
# Ubuntu or Debian
sudo apt install pv

# CentOS
sudo dnf install pv
```

With the prerequisites all set, you are ready to start migrating!

## Exporting data from your old database

When you’ve set up your new Managed Database and a Cloud Server to facilitate the migration, you can start by taking a backup of your old MySQL database. This is done using the `mysqldump` command-line tool to create a single-file backup.

**Note that the migration process will take some time.** You should stop any applications from modifying the database during the migration which can create some downtime to your services. To help estimate the downtime caused by the migration, you should do a practice run of the migration before committing to the move.

Create a backup of your MySQL database by running the command below. Replace the database name, hostname and username with those corresponding to your old database. You may also need to change the port number if your database doesn’t use the default port.

`mysqldump --database databasename(s) -h source.db.hostaddress.com -P 3306 -u username -p --single-transaction --set-gtid-purged=OFF --hex-blob | pv > mydb_export.sql`

The command will export the database into a file `mydb_export.sql` in the directory it is executed in.

- `databasename(s)` is used to define the names of the databases you want to export.
  If you have multiple databases, you can split the task and migrate them individually or migrate them together with `--databases db1 db2` etc.
- `-h source.db.hostaddress.com` defines the database host you want to export.
  Note that if your old database is not in the same UpCloud data centre as the Cloud Server used for the migration, you’ll need to allow connection over the public network.
- `-P 3306` sets the port number used to connect to the database host. Change it as needed according to your old database connection settings.
- `-u username -p` options are used to pass the credentials needed to access the database.
  Note that it is insecure to include the password in the command itself. Rather you will be prompted to enter your password when running the command.
- `--single-transaction` option is used to start a transaction before running the export instead of locking the entire database.
  This way mysqldump can read the database in its current state at the time of the transaction which makes the data dump consistent. Note that only InnoDB tables are dumped in a consistent state using this option. For example, any MyISAM or MEMORY tables may still change state while exporting using this option.
- `--set-gtid-purged=OFF` option should be set if you are using Global Transaction Identifiers (GTID) so that the target server records these transactions as applied.
  For a server where GTIDs are not in use, use the AUTO option. Only use this option for a server where GTIDs are in use if you are sure that the required GTID set is already present in gtid\_purged on the target server and should not be changed, or if you plan to identify and add any missing GTIDs manually.

## Importing data to Managed Databases

After you have exported your MySQL database to the Cloud Server, you can then begin importing the data to your new Managed Database.

`pv mydb_export.sql | mysql -h target.db.upclouddatabases.com -P 11550 -u upadmin -p`

The MySQL client command used to import the data has mostly the same parameters as the mysqldump in the previous section. Below is a quick recap of the parameters you will need to set.

- `-h target.db.upclouddatabases.com` defines the database host.
- `-P 11550` sets the port number used to connect to the database host.
- `-u upadmin -p` options are used to pass the credentials needed to access the database.
  You will be prompted to enter your password when running the command. The password for your *upadmin* account can be found in your [UpCloud Control Panel](https://hub.upcloud.com/database/).

## Recreating user accounts

Having finished migrating over your MySQL databases to the UpCloud Managed Databases, you are almost done. However, you will still need to recreate the user accounts used to access your databases by your applications.

You can check the list of users in your old database by connecting with the MySQL client and using the following query.

`mysql databasename -h source.db.hostaddress.com -P 3306 -u username -p`

`SELECT user,host FROM mysql.user;`

```
+-----------------------+------------+
| user                  | host       |
+-----------------------+------------+
| repluser              | %          |
| root                  | %:%        |
| wordpress             | 10.5.9.116 |
| metrics_user_datadog  | ::1        |
| metrics_user_telegraf | ::1        |
| mysql.infoschema      | localhost  |
| mysql.session         | localhost  |
| mysql.sys             | localhost  |
+-----------------------+------------+
8 rows in set
Time: 0.013s
```

In the example above, we have a user account called wordpress that is used by a WordPress website. It will need to be recreated in the new database to allow WordPress to be switched over.

Next, connect to the new database using the MySQL client.

`mysql databasename -h target.db.upclouddatabases.com -P 11550 -u upadmin -p`

Then run the following commands to create the user and grant it permissions to the relevant database.

```
CREATE USER 'username'@'app.host.ip' IDENTIFIED BY 'password';
GRANT ALL ON databasename.* TO 'username'@'app.host.ip';
FLUSH PRIVILEGES;
```

Once done, you can exit the command-line client and continue below with finalising the migration.

## Finalising the migration

To finalise the migration, you should still run the [mysqlcheck](https://dev.mysql.com/doc/refman/8.0/en/mysqlcheck.md) on the database to ensure proper database statistics are in place for the newly loaded data.

The `mysqlcheck` command-line tool is used to perform table maintenance to check, repair, optimise, or analyse tables. The tables are locked for the duration of the check operation and are therefore unavailable to other sessions so this should be run before the new database is adapted to use. Note that this check operation can be time-consuming depending on the size and number of tables in the database.

Run the `mysqlcheck` command on your new Managed Database using the example underneath. Remember to replace the host address with yours.

`mysqlcheck databasename -h target.db.upclouddatabases.com -P 11550 -u upadmin -p`

The output of the check command would be similar to the example below.

```
databasename.table1                                  OK
databasename.table10                                 OK
databasename.table2                                  OK
databasename.table3                                  OK
databasename.table4                                  OK
databasename.table5                                  OK
databasename.table6                                  OK
databasename.table7                                  OK
databasename.table8                                  OK
databasename.table9                                  OK
```

Once all tables have been checked, your MySQL database migration is complete!

You can now begin configuring your applications to use the new Managed Databases.

For example, reconfigure the database connection details for a WordPress instance by setting up the wp-config.php file by making a backup of the existing file and then change the settings as indicated below.

```
cp /var/www/html/wordpress/wp-config.php /var/www/html/wordpress/wp-config-backup.php
nano /var/www/html/wordpress/wp-config.php
```

Set the database and username as shown below and replace the password and hostname with the details of the new Managed Database.

```
// ** MySQL settings - You can get this info from your web host ** //
/** The name of the database for WordPress */
define( 'DB_NAME', 'wordpress' );

/** MySQL database username */
define( 'DB_USER', 'wordpress' );

/** MySQL database password */
define( 'DB_PASSWORD', 'password' );

/** MySQL hostname */
define( 'DB_HOST', 'hostname.db.upclouddatabases.com:11550' );
```

When done, save the file and exit the editor. The WordPress site should then be connected to the new Managed Database.
