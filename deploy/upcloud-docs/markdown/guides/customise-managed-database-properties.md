# How to customise Managed Database properties

Managed Databases offer many benefits over manual maintenance such as ease of deployment, configuration and backups. However, while the default configurations are optimised according to the service plans, some aspects might not be ideal in specific use cases. Therefore, we’ve exposed certain database properties for you to customise via the UpCloud API.

Database configuration properties allow you to customise your Managed Database for finer details such as logging parameters, certain timeouts or buffer sizes. Follow along with this guide to see which properties you can customise and how to do so.

## Getting started with UpCloud API

[UpCloud API](https://developers.upcloud.com/) offers a developer-centric approach to all the same services and features that are available via UpCloud Control Panel. To use the API, you will need to enable access using your UpCloud account or sub-account credentials.

If you are new to using the API, check out our [introductory guide](/docs/guides/getting-started-upcloud-api.md) to find out how to get started. When you are set to run requests, continue ahead with the API requests regarding Managed Database properties below.

## Listing configuration properties

The available configuration properties depend on the database type you are using. Both MySQL and PostgreSQL have their own customisable properties which can be listed by querying the service types.

Use the request examples in the following sections to list the available service plans and properties for your database type.

### MySQL properties

For MySQL databases, run the API request underneath.

```
GET /1.3/database/service-types/mysql
```

You will then get a response with an output like the example below.

```
HTTP/1.0 200 OK
```

```
{
    "name": "mysql",
    "description": "MySQL - Relational Database Management System",
    "latest_available_version": "8.0.26",
    "service_plans": [
        ... service plan options ...
    ],
    "properties": {
        "admin_password": {
            "createOnly": true,
            "example": "z66o9QXqKM",
            "maxLength": 256,
            "minLength": 8,
            "pattern": "^[a-zA-Z0-9-_]+$",
            "title": "Custom password for admin user. Defaults to random string. This must be set only when a new service is being created.",
            "type": ["string","null"],
            "user_error": "Must consist of alphanumeric characters, underscores or dashes"
        },
        "admin_username": {
            "createOnly": true,
            "example": "avnadmin",
            "maxLength": 64,
            "pattern": "^[_A-Za-z0-9][-._A-Za-z0-9]{0,63}$",
            "title": "Custom username for admin user. This must be set only when a new service is being created.",
            "type": ["string","null"],
            "user_error": "Must consist of alphanumeric characters, dots, underscores or dashes, may not start with dash or dot, max 64 characters"
        },
        "automatic_utility_network_ip_filter": {
            "default": true,
            "title": "Automatic utility network IP Filter",
            "type": "boolean",
            "description": "Automatically allow connections from servers in the utility network within the same zone"
        },
        "backup_hour": {
            "example": 3,
            "title": "The hour of day (in UTC) when backup for the service is started. New backup is only started if previous backup has already completed.",
            "type": ["integer","null"],
            "minimum": 0,
            "maximum": 23
        },
      ... more configurations properties ...
    }
  }
}
```

The above output has been truncated for brevity, the actual list of customisable properties can be found in the [Managed Database documentation](/docs/products/managed-mysql/customisable-properties.md).

### PostgreSQL properties

PostgreSQL-specific properties can be listed with the following request.

```
GET /1.3/database/service-types/pg
```

You will then get a response with an output like the example below.

```
HTTP/1.0 200 OK
```

```
{
    "name": "pg",
    "description": "PostgreSQL - Object-Relational Database Management System",
    "latest_available_version": "14.2",
    "service_plans": [
        ... service plan options ...
    "properties": {
        "admin_password": {
            "createOnly": true,
            "example": "z66o9QXqKM",
            "maxLength": 256,
            "minLength": 8,
            "pattern": "^[a-zA-Z0-9-_]+$",
            "title": "Custom password for admin user. Defaults to random string. This must be set only when a new service is being created.",
            "type": [
                "string",
                "null"
            ],
            "user_error": "Must consist of alphanumeric characters, underscores or dashes"
        },
        "admin_username": {
            "createOnly": true,
            "example": "avnadmin",
            "maxLength": 64,
            "pattern": "^[_A-Za-z0-9][-._A-Za-z0-9]{0,63}$",
            "title": "Custom username for admin user. This must be set only when a new service is being created.",
            "type": [
                "string",
                "null"
            ],
            "user_error": "Must consist of alphanumeric characters, dots, underscores or dashes, may not start with dash or dot, max 64 characters"
        },
        "automatic_utility_network_ip_filter": {
            "default": true,
            "title": "Automatic utility network IP Filter",
            "type": "boolean",
            "description": "Automatically allow connections from servers in the utility network within the same zone"
        },
        "autovacuum_analyze_scale_factor": {
            "title": "autovacuum_analyze_scale_factor",
            "type": "number",
            "description": "Specifies a fraction of the table size to add to autovacuum_analyze_threshold when deciding whether to trigger an ANALYZE. The default is 0.2 (20% of table size)",
            "minimum": 0,
            "maximum": 1
        },
      ... more configurations properties ...
    }
  }
}
```

The example output has been truncated for brevity. Run the request or refer to the [Managed Database documentation](/docs/products/managed-postgresql/customisable-properties.md) for the full list of customisable properties.

## Setting custom database properties

Configuration properties can be set either during Managed Database creation or modified afterwards.

For example, you can set the properties you want when creating a new Managed Database. Simply include the properties section with the nested parameters you want.

```
POST /1.3/database
```

```
{
  "hostname_prefix": "doc-api-unique-prefix",
  "plan": "1x1xCPU-2GB-25GB",
  "title": "my-managed-database",
  "type": "mysql",
  "zone": "de-fra1",
  "maintenance": {
    "dow": "sunday",
    "time": "05:00:00"
  },
  "properties": {
    "automatic_utility_network_ip_filter": true,
    "backup_hour": 4,
    "backup_minute": 30
  }
}
```

Alternatively, if you already have a Managed Database instance up and running, you can modify the properties using the PATCH request.

Use the following request and body as an example. Note that you will need to identify the correct Managed Database using its UUID.

```
PATCH /1.3/database/{uuid}
```

Then define the properties you want to change in the request body.

```
{
  "properties": {
    "automatic_utility_network_ip_filter": true,
    "backup_hour": 4,
    "backup_minute": 30
  }
}
```

After a successful request to change the database properties, you will get a confirmation of the new configuration in the response.

## Conclusions

Managed Databases offer an easy-to-use, expert-level configuration for many database needs. It provides a turn-key solution for databases including replication and point-in-time backups which normally require a significant amount of configuration. With the bulk of the work already done, you are free to focus on the finer details such as the configuration properties.

However, there are some restrictions on what properties you can customise to ensure service stability. As such, not all properties can be set through the API at this time. If you come across a database configuration property that is not currently listed and you would like to change, [get in touch](https://upcloud.com/contact/)! We are always happy to work with our customers to improve the usability of Managed Databases.
