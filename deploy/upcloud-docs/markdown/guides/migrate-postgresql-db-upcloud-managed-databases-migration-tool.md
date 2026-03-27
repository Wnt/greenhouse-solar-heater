# How to migrate PostgreSQL database to UpCloud Managed Databases using the migration tool

UpCloud's migration tool provides a streamlined way to move your PostgreSQL databases from external servers to the UpCloud Managed Databases service.

The migration tool offers two ways to migrate a PostgreSQL database: **replication** method and **pg\_dump** method. You can perform either method through the UpCloud Control Panel, or via the command-line using the provided scripts.

Both methods require that your source PostgreSQL server has a superuser account with sufficient privileges to read all database content. This account must be able to log in from any IP address, or at least from the public IP address of your UpCloud Managed Database.

Before diving into the migration process, it's important to note that you should always test your migration in a non-production environment first. Also, ensure that you have recent backups of your data before beginning any migration process.

Please note these important limitations that apply regardless of which method you choose:

- Schema changes during migration may cause replication to fail
- System databases (`information_schema`, `pg_catalog`, `pg_temp`, etc.) are excluded from the migration
- Database users are not migrated and must be created separately

### Replication method

Logical replication is the default method which keeps your source database and the UpCloud Managed Database synchronised until the replication is stopped. Changes made to your source database are automatically replicated to the target, allowing for minimal downtime when you eventually switch over.

The replication method is ideal when you need to keep downtime to an absolute minimum, as your applications can continue using the source database while the migration is in progress.

**Requirements for replication method:**

- Source database must be running PostgreSQL version 10 or later
- `wal_level` needs to be set to `logical`
  - Or for AWS RDS, `rds.logical_replication` needs to be set to `1`
- Supports only FOR ALL TABLES publication in source
- Migration requires replication slots, so you may need to increase available replication slots
- You need superuser or superuser-like privileges in both source and target database
  - Or you can use [aiven-extras](https://github.com/aiven/aiven-extras) extension

You can check your current PostgreSQL server configuration by running:

```
SHOW wal_level;
SHOW max_replication_slots;
```

If `wal_level` is not set to `logical`, you'll need to modify your PostgreSQL configuration file (`postgresql.conf`) and restart the server:

```
wal_level = logical
```

### pg\_dump method

This method creates a snapshot of your source database at a specific point in time, which is then transferred to the target database. It's simpler than the replication method but requires a period during which the source database remains unchanged.

**Requirements for pg\_dump method:**

- The UpCloud Managed Database must be able to access the source PostgreSQL server.
- You should lock the source database from changes during the migration process, as this can cause downtime. If you allow write operations to the database during the pg\_dump migration, you are likely to have changes that will not be migrated.

### Choosing the best approach for your needs

If minimising downtime is important and your source database meets the requirements, the replication method is the recommended approach. It is especially useful for busy production databases where continuous operation is needed.

If your database is smaller, doesn't change frequently, or if you're able to schedule downtime, the pg\_dump method offers simplicity and wider compatibility.

## Migrating with the UpCloud Control Panel

Now let's walk through the migration process using the UpCloud Control Panel.

### Preparing for migration

Before starting, ensure you have:

- Created a Managed Database service on UpCloud
- Access credentials for your source database
- Verified your source database is accessible from UpCloud's network
- Documented your existing database users for recreation later

### Setting up the migration

Begin by logging into your UpCloud Control Panel and navigating to your Managed Database service.

Click the "Settings" tab and scroll down to the Migration section. This is where you'll configure all the details needed to connect to your source database and initiate the migration.

![The migration section in the control panel](migration-section.png)

You'll notice two configuration options: using a **connection URI** or **manually entering the connection details**. The connection URI is a convenient option if you have a connection string available. Otherwise, the manual configuration provides a more guided approach.

![PostgreSQL URI or manual configuration options](pgsql-2.png)

When configuring manually, you'll need to select your preferred migration method first – either replication or dump (pg\_dump). Then, provide the details of your source database:

- The hostname or IP address of your source database server
- The port number (typically 5432 for PostgreSQL)
- Username and password with sufficient privileges
- An initial database to connect to (often "postgres")

If there are specific databases you want to exclude from migration, you can list them in the "Ignore databases" field. This is useful when you only want to migrate certain databases from a server that contains many.

You can also specify whether to use SSL for the connection to your source database. Using SSL is recommended when your source database is accessible over the public internet, as it encrypts the data in transit.

### Verification and validation

After entering your connection details, the migration tool will verify whether the migration is possible with your settings. This validation step checks connectivity to your source database and assesses the preferred migration method based on your database configuration.

![PostgreSQL migration verification results](pgsql-4.png)

The verification results will indicate if there are any issues that need to be addressed. For example, if you've selected the replication method but your source database doesn't have `wal_level` set to `logical`, you'll receive a notification suggesting you enable it or use the pg\_dump method instead.

This step is important for identifying potential problems before starting the actual migration. If issues are found, you can adjust your source database configuration or change your migration method accordingly.

### Starting and monitoring the migration

Once the verification is successful, you can start the migration process.

The migration will begin immediately, and you'll be presented with a progress window that provides real-time status updates.

![PostgreSQL migration progress monitoring](pgsql-6.png)

The migration time depends on the size of your databases and the complexity of your data. Small databases might migrate in minutes, while larger ones could take a few hours.

It's important to note that PostgreSQL migration might initially fail for some databases but will be automatically retried, so you should be patient and monitor the progress window.

![PostgreSQL migration final status](pgsql-7.png)

### Completing the migration

When the migration status shows as complete for all databases, it's time to finalise the process:

1. Verify your data has been transferred correctly by connecting to the new database and checking key tables and records.
2. Create your database users via the UpCloud Hub. Remember that user accounts aren't migrated automatically, so you'll need to recreate them with the appropriate permissions.
3. Update your application configuration to point to the new database. This involves changing the connection details in your application's configuration files or environment variables.
4. If you used the replication method, your source and target databases will remain in sync until you disable replication. This gives you a safety net – if anything goes wrong after switching to the new database, you can easily switch back while you troubleshoot.
5. Once you're confident everything is working correctly with the new database, you can disable replication from the settings page if you used that method.

## Migrating with command-line tools

For those who prefer working from the command line or need to automate the migration process, UpCloud provides a set of bash scripts that perform the same functions as the Control Panel interface.

[start-migration-pre-checks.sh](/docs/guides/migrate-postgresql-db-upcloud-managed-databases-migration-tool/scripts/start-migration-pre-checks.txt.md): This script validates your migration settings before you begin the actual migration. It is a good way to identify potential issues early in the process.

[start-migration.sh](/docs/guides/migrate-postgresql-db-upcloud-managed-databases-migration-tool/scripts/start-migration.txt.md): Use this script to start migration to an existing UpCloud Managed Database instance. If you've already created your UpCloud Managed database through the Control Panel or other means, this script initiates the migration process.

[create-dbaas-and-migrate.sh](/docs/guides/migrate-postgresql-db-upcloud-managed-databases-migration-tool/scripts/create-dbaas-and-migrate.txt.md): This script creates a new UpCloud Managed Database instance and immediately starts migration from your source database. It's useful when you want to set up a new Managed Database and migrate in a single step.

[monitor-dbaas.sh](/docs/guides/migrate-postgresql-db-upcloud-managed-databases-migration-tool/scripts/monitor-dbaas.txt.md): Once migration has started, this script lets you monitor its progress. It provides regular updates on the status of each database being migrated.

[disable-replication.sh](/docs/guides/migrate-postgresql-db-upcloud-managed-databases-migration-tool/scripts/disable-replication.txt.md): After completing a migration that uses the replication method, this script disables the ongoing replication when you're ready to fully disconnect from the source database.

### Setting up your environment

Before using the scripts above, you'll need to set up your environment with your UpCloud API credentials. This allows the scripts to authenticate with UpCloud's API.

Export your username and password as environment variables:

```
export UPCLOUD_USERNAME=Your_username
export UPCLOUD_PASSWORD=Your_password
```

### Validating your migration settings

It's always good to validate your migration settings before starting the actual process. The pre-checks script helps you identify potential issues that might prevent successful migration.

Here's how to use it:

```
bash start-migration-pre-checks.sh \
  -u YOUR_DATABASE_UUID \
  -H SOURCE_HOST_IP \
  -U SOURCE_USERNAME \
  -p SOURCE_PASSWORD \
  -P SOURCE_PORT \
  -d INITIAL_DATABASE \
  -m replication \
  -s true
```

You'll need to replace the placeholder values with your actual database details:

- `YOUR_DATABASE_UUID` is the UUID for your existing UpCloud Managed Database
- `SOURCE_HOST_IP` is the hostname or IP address of your source database
- `SOURCE_USERNAME` and `SOURCE_PASSWORD` are the credentials for accessing your source database
- `SOURCE_PORT` is the port (typically 5432 for PostgreSQL)
- `INITIAL_DATABASE` is the name of a database to use for the initial connection (often "postgres")
- The `-m` parameter specifies your preferred migration method (`replication` or `dump`)
- The `-s` parameter indicates whether to use SSL (`true` or `false`)

When you run this command, the script will check whether your source database is accessible and whether your chosen migration method is suitable. It will provide detailed feedback, helping you adjust your settings if needed.

```
# Example command
bash start-migration-pre-checks.sh \
  -u 09f22e89-13a4-4e1f-95fd-ac613707145a \
  -U superuser \
  -p YourPassW0rd \
  -P 5432 \
  -d postgres \
  -m replication \
  -s true \
  -H 5.22.221.106
```

```
# Example output
Creating migration check task…

Success: migration check task created
id: 253d883b-ef34-4db4-a71c-2456dfed3ba9

Polling for migration check task result...

Task Result : poll #1
{
  "create_time": "2024-10-31T10:37:56Z",
  "operation": "pg_migration_check",
  "id": "253d883b-ef34-4db4-a71c-2456dfed3ba9",
  "result_codes": [],
  "result": "Migration method will be 'replication'.",
  "success": true
}

migration check task completed
```

### Starting migration to an existing Managed Database

If you already have a Managed Database instance set up and you've validated your migration settings, you can start the migration process with the `start-migration.sh` script:

```
bash start-migration.sh \
  -u YOUR_DATABASE_UUID \
  -H SOURCE_HOST_IP \
  -U SOURCE_USERNAME \
  -p SOURCE_PASSWORD \
  -P SOURCE_PORT \
  -d INITIAL_DATABASE \
  -m replication \
  -s false
```

The parameters are the same as for the pre-checks script. This command configures your UpCloud Managed Database to connect to your source database and begin the migration process.

The script will output details about your Managed Database service, including the updated migration settings. If everything is configured correctly, the migration will start immediately.

```
# Example command
bash start-migration.sh \
  -u 09fc3cec-fa71-4979-8aa3-ec7594cb944d \
  -H 5.22.221.106 \
  -U superuser \
  -p YourPassW0rd \
  -P 5432 \
  -s false \
  -d postgres
```

```
# Example output
{
  "backups": [
    {
      "backup_time": "2024-10-10T12:40:20.672000Z",
      "data_size": 36259840
    }
  ],
  "components": [
    {
      "component": "pg",
      "host": "upcloud-test-mystmtdaytdt.db.upclouddatabases.com",
      "port": 11550,
      "route": "dynamic",
      "usage": "primary"
    },
     ... API response about DBaaS service ...
  "properties": {
    "automatic_utility_network_ip_filter": true,
    "ip_filter": [],
    "max_replication_slots": 40,
    "migration": {
      "dbname": "postgres",
      "host": "5.22.221.106",
      "password": "YourPassW0rd",
      "port": 5432,
      "ssl": false,
      "username": "superuser"
    },
    "public_access": true,
    "version": "13"
  },
       ... API response about DBaaS service ...
  "zone": "pl-waw1"
}
```

### Monitoring migration progress

Once you've started the migration, you'll want to keep an eye on its progress. The `monitor-dbaas.sh` script provides regular updates on the status of your migration:

```
bash monitor-dbaas.sh -u YOUR_DATABASE_UUID
```

```
# Example command
bash monitor-dbaas.sh -u 09fc3cec-fa71-4979-8aa3-ec7594cb944d
```

With PostgreSQL migration, you might see that some databases initially fail but are automatically retried. You should be patient and continue monitoring until all databases show a "syncing" or "done" status:

```
# Example output
{
  "error": "Logical replication is currently down. Please make sure all schemas changes are also applied downstream",
  "method": "replication",
  "seconds_behind_master": 0,
  "source_active": true,
  "status": "failed",
  "databases": [
    {
      "dbname": "test2",
      "error": "Logical replication is currently down. Please make sure all schemas changes are also applied downstream",
      "method": "replication",
      "status": "failed"
    },
    {
      "dbname": "test1",
      "error": "Logical replication is currently down. Please make sure all schemas changes are also applied downstream",
      "method": "replication",
      "status": "failed"
    },
    {
      "dbname": "postgres",
      "method": "replication",
      "status": "syncing"
    },
    {
      "dbname": "test3",
      "error": "Logical replication is currently down. Please make sure all schemas changes are also applied downstream",
      "method": "replication",
      "status": "failed"
    }
  ]
}
...
{
  "method": "replication",
  "seconds_behind_master": 0,
  "source_active": true,
  "status": "done",
  "databases": [
    {
      "dbname": "postgres",
      "method": "replication",
      "status": "syncing"
    },
    {
      "dbname": "test3",
      "method": "replication",
      "status": "syncing"
    },
    {
      "dbname": "test1",
      "method": "replication",
      "status": "syncing"
    },
    {
      "dbname": "test2",
      "method": "replication",
      "status": "syncing"
    }
  ]
}
```

This script polls the migration status every few seconds and displays the current state of each database being migrated. The output includes:

- The overall migration status
- The migration method being used
- For replication, how far behind the target is in applying changes
- Individual status for each database

The script runs continuously, refreshing the status information every 10 seconds. You can stop it with `ctrl+c` when you no longer need to monitor the progress.

As each database completes migration, its status will change from "running" to "syncing" to "done." When all databases show as syncing or done, the migration is complete.

### Creating a new Managed Database and starting migration

If you prefer to create a new Managed Database instance and start migration in a single step, you should use the `create-dbaas-and-migrate.sh` script:

```
bash create-dbaas-and-migrate.sh \
  -n YOUR_DATABASE_HOSTNAME \
  -S DATABASE_PLAN \
  -z DATABASE_REGION \
  -H SOURCE_HOST_IP \
  -U SOURCE_USERNAME \
  -p SOURCE_PASSWORD \
  -P SOURCE_PORT \
  -d INITIAL_DATABASE \
  -m replication \
  -s false \
  -v DATABASE_VERSION
```

This script has additional parameters for creating the UpCloud Managed Database instance:

- `YOUR_DATABASE_HOSTNAME` is the hostname prefix for your new UpCloud Managed Database service
- `DATABASE_PLAN` specifies the Managed Database plan (adjust according to your needs)
- `DATABASE_REGION` is the data centre location for the new Managed Database
- `DATABASE_VERSION` is the PostgreSQL version (e.g., 13, 14, 15)

The script will create the new UpCloud Managed Database, configure it for migration, and start the migration process. It will output the UUID of the new service, which you'll need for monitoring the migration's progress.

```
# Example command
bash create-dbaas-and-migrate.sh \
  -n upcloud-test \
  -S 2x2xCPU-4GB-50GB \
  -z pl-waw1 \
  -H 5.22.221.106 \
  -U superuser \
  -p YourPassW0rd \
  -P 5432 \
  -s false \
  -d postgres \
  -v 13
```

```
# Example output
{
  "backups": [],
  "components": [
    {
      "component": "pg",
      "host": "upcloud-test-mystmtdaytdt.db.upclouddatabases.com",
      "port": 11550,
      "route": "dynamic",
      "usage": "primary"
    },
  ... API response about created DBaaS service ...
  "zone": "pl-waw1"
}
UUID of created DBaaS service:
09fc3cec-fa71-4979-8aa3-ec7594cb944d
```

### Completing the migration

After the migration has completed successfully, follow these steps to finish the process:

1. Verify that all your data has been migrated correctly by connecting to the new database
2. Create your database users through the UpCloud Control Panel
3. Update your application configuration to use the new database connection details
4. If you used the replication method, you can disable replication when you're ready with the `disable-replication.sh` script:

```
bash disable-replication.sh -u YOUR_DATABASE_UUID
```

This script removes the migration configuration from your UpCloud Managed Database, stopping the replication process. Only run this when you're confident that your applications are working correctly with the new database.

## Post migration

Regardless of which migration method you used, there are a few important tasks to complete after migration.

### Setting up database users

Your database users and their permissions don't get migrated automatically. You'll need to create them manually on your new UpCloud Managed Database instance.

To see the users in your old database, you can run:

```
psql -h <SOURCE_HOST> -p <PORT> -U <USERNAME> -c "SELECT usename, usesuper FROM pg_catalog.pg_user;"
```

This will show you a list of all users and whether they have superuser privileges. Make note of the users that your applications need.

Then, for each necessary user, connect to your new UpCloud Managed Database service and create the user with appropriate permissions:

```
psql -h <YOUR_DATABASE_HOSTNAME> -p <ASSIGNED_PORT> -U upadmin -c "CREATE USER appuser WITH PASSWORD 'secure_password';"
psql -h <YOUR_DATABASE_HOSTNAME> -p <ASSIGNED_PORT> -U upadmin -c "GRANT ALL PRIVILEGES ON DATABASE database_name TO appuser;"
```

Replace `appuser`, `secure_password`, and `database_name` with your actual values.

### Updating application configurations

Now it's time to update your applications to use the new database. This typically involves changing connection details in configuration files.

For example, if you're running a Django application, you'd edit the settings.py file:

```
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'your_database_name',
        'USER': 'your_database_user',
        'PASSWORD': 'your_database_password',
        'HOST': 'your-dbaas-hostname.db.upclouddatabases.com',
        'PORT': '11550',
    }
}
```

For other applications, consult their documentation to find out where database connection settings are stored.

### Verifying your migration

Before considering the migration complete, it's important to verify that everything works as expected:

1. Connect to your new database and check that all expected tables and data are present.
2. Run your application against the new database and test all key functionality.
3. Check that database users have the correct permissions by testing each application function that interacts with the database.
4. Monitor database performance to ensure it's meeting your expectations.

If you discover any issues, you can investigate and address them before fully decommissioning your old database. If you used the replication method, your source database remains in sync with the target until you disable replication, giving you a safety net during this verification process.

## Troubleshooting common issues

Even with careful planning, you might encounter issues during the migration process. Here are some common problems and their solutions:

### Missing permissions for logical replication

If your verification step fails with an error message like this:

```
Result: Cannot migrate database using 'replication', missing requirements for logical replication are:
- User cannot manage replication slots in database 'dvdrental': use superuser or install aiven_extras
```

This indicates the migration user doesn't have sufficient privileges to manage replication slots, which are required for logical replication. There are two ways to fix this:

1. **Use a superuser account** for the migration (recommended if possible)
2. **Install the aiven\_extras extension** in each database you want to migrate:

   ```
   -- Connect to each database that needs to be migrated
   \c database_name

   -- Install the extension
   CREATE EXTENSION aiven_extras;
   ```

You need to run this command for each database you want to replicate. The aiven\_extras extension grants the necessary permissions to manage replication without requiring full superuser privileges.

After installing the extension, run the verification check again, and it should pass successfully.

### Migration verification fails due to provider-specific system databases

If you see an error message like this during the verification step:

```
Result: connection to database "_dodb" got rejected
```

Or similar errors about specific databases being rejected, this is likely due to cloud provider-specific system databases.

Managed database services (like DigitalOcean, Vultr, Azure Database, etc.) often include proprietary system databases that are used for provider-specific management functions. These databases:

- Cannot be accessed with normal migration tools
- Are not needed in your new UpCloud database
- Should be excluded from migration

**Example solution for Digital Ocean:**
When migrating from Digital Ocean, exclude the "\_dodb" database by adding it to the "Ignore databases" field.

**How to identify provider-specific databases:**
List all databases with the `\l` command and look for:

- Databases owned by system users (like "postgres" rather than your admin user)
- Names with special patterns (leading underscores, provider prefixes)
- Unusual access privileges
- Databases not created by you

Excluding these databases will allow the migration to proceed normally while ignoring the databases that aren't relevant to your application.

### DBaaS active node is unable to login to source database

After you have enabled migration, you might see PostgreSQL log something similar to this:

```
2024-10-10 10:38:21.184 UTC [8823] superuser@test FATAL:  no pg_hba.conf entry for host "5.22.221.26", user "superuser", database "test3", SSL on
2024-10-10 10:38:21.188 UTC [8824] superuser@test FATAL:  no pg_hba.conf entry for host "5.22.221.26", user "superuser", database "test3", SSL off
```

This means that the DBaaS active node is trying to login to your database server, but the connection is being rejected. You need to add an entry to your `pg_hba.conf` file to allow connections from the UpCloud Managed Database IP address:

```
# Add to pg_hba.conf
host    all             superuser        5.22.221.26/32           md5
```

After making this change, reload the PostgreSQL configuration:

```
sudo pg_ctl reload
```

### One or more databases fail due to PostgreSQL replication slots

If you are getting the following or similar error:

```
HINT: You might need to increase max_logical_replication_workers.
WARNING: out of logical replication worker slots
```

You will need to check `max_logical_replication_workers` and `max_replication_slots` in the Properties tab of your UpCloud Managed Database and increase the values. You might also need to increase the same values in your source database server.

### Migration initially fails with some databases

Often initially the migration status is failed and many databases are in a failed state, but after migration has been running for a while, databases are able to sync. This is normal behavior for PostgreSQL migration, and you should be patient and continue monitoring until all databases show a "syncing" or "done" status.

### PostgreSQL publication already exists

If you get the following error logs in your source database server:

```
ERROR:  publication "aiven_db_migrate_ad0234829205b9033196ba818f7a872b_pub" already exists
STATEMENT:  CREATE PUBLICATION aiven_db_migrate_ad0234829205b9033196ba818f7a872b_pub FOR ALL TABLES WITH (publish = 'INSERT,UPDATE,DELETE,TRUNCATE')
```

This means migration started but something went wrong with it. You need to check if any migration publication exists and drop it:

```
SELECT * FROM pg_catalog.pg_publication;
DROP PUBLICATION IF EXISTS aiven_db_migrate_098f6bcd4621d373cade4e832627b4f6_pub;
```

After dropping the publication, you can start the migration process again.

## Conclusion

Migrating your PostgreSQL databases to UpCloud Managed Databases using the migration tool is a straightforward process that can significantly reduce the operational overhead of database management. Whether you choose the replication method for minimal downtime or the pg\_dump method for simplicity, the migration tool guides you through each step of the process.

With proper planning and the right approach, you can move your databases to UpCloud's Managed Database service with confidence, knowing that your data is safe and your applications will continue to function seamlessly.

For additional support or questions about the migration process, don't hesitate to reach out to our customer support team, who are available 24/7 to assist with your database migration needs.
