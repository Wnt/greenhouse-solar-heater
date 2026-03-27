# How to enable PostgreSQL connection pool using UpCloud API

PostgreSQL connection pool allows you to serve a larger number of client connections to any given Managed Database than normally possible while keeping the server resource usage low. With connection pooling enabled, client connections are grouped together and do not each take up a separate backend process on the server. Therefore, adding a connection pooler that utilises fewer backend connections frees up server resources for more important uses.

## Accessing UpCloud API

UpCloud API offers a programmable interface to all of our services and features with easy-to-understand commands. If you are new to our API, have a look at our guide on [how to get started](/docs/guides/getting-started-upcloud-api.md).

In this guide, we’ll explain the API queries you can use to create and manage your PostgreSQL connection pool. Full [documentation](https://developers.upcloud.com/1.3/16-managed-database/#list-connection-pools-postgresql) of our API is available for advanced users who might want to skip to the point.

## Connection pooling modes

Connection pools support three different operational modes: “session”, “transaction” and “statement”. Each of the modes works a little differently to suit a number of varying use cases.

### Session

This pooling mode grants server-side connection access to clients and holds it until the client disconnects from the pooler. Afterwards, the disconnected server connection is returned to the connection pooler’s free connection list to wait for the next client connection.

If all server connections are in use, new client connections will be accepted, but new queries will only proceed once another client disconnects.

Session pooling can be useful for providing a waiting queue for incoming connections while limiting server memory usage. However, due to the slow recycling of the backend connections, it can be impractical in most common use cases.

### Transaction

Connection pooling using transaction mode allows each client connection to take a turn in using a backend connection for the duration of a single transaction. After the transaction is committed, the backend connection is freed for the next waiting client connection to reuse the same connection.

In practice, this provides quick response times for queries as long as the typical transaction execution times are not excessively long.

Transaction pooling is the most commonly used connection pooling mode.

### Statement

Similar to the “transaction” pooling mode, but instead of allowing a full transaction per turn, server-side connections are cycled after every database statement such as SELECT, INSERT, UPDATE, DELETE.

Transactions containing multiple SQL statements are not allowed in this mode.

Statement pooling mode could be used, for example, for running sharding proxies.

## Getting connection pool details

PostgreSQL Managed Databases can have more than one connection pool used for different logical databases and database users. You can get a list of all connection pools for a given Managed Database identified by a UUID with the following command.

```
GET /1.3/database/{uuid}/connection-pools
```

Furthermore, you can get details on individual connection pools by selecting one by name.

```
GET /1.3/database/{uuid}/connection-pools/{pool_name}
```

The response would include the connection pool details such as in the example below.

```
{
    "connection_uri": "postgres://{username}:{password}@{dbname}.db.upclouddatabases.com:11551/pool-1?sslmode=require",
    "database": "defaultdb",
    "pool_mode": "transaction",
    "pool_name": "pool-1",
    "pool_size": 10,
    "username": "upadmin"
}
```

The same details, with the exception of connection\_uri, are needed for creating a new pool.

## Creating a new connection pool

Creating a new connection pool takes but a simple POST request with the required parameters set in the request body. The example request shown below lists everything needed.

```
POST /1.3/database/{uuid}/connection-pools
```

```
{
  "database": "defaultdb",
  "pool_mode": "transaction",
  "pool_name": "pool-1",
  "pool_size": 10,
  "username": "upadmin"
}
```

The parameters required for creating a new connection pool include the following.

- **Database** name is required to identify the logical database the pool connects to.
- **Pool name** needs to be unique as it is used as a part of the connection parameter for your pooled client connections.
- **Pool mode** defines the method used to manage client connection as described in *Connection pooling modes*.
- **Pool size** sets the limit to how many server connections the pool can use at a time. The recommended limit is roughly 3-5 times the number of CPU cores allocated in your Managed Database node configuration.
- **Username** selects which user is allowed to connect to the backend database. Leaving this empty will allow all users with permission to that specific database.

When you create a connection pool, you get a response to confirm the action. The response also shows your new *connection\_uri* that you can use to connect to the database. You will also have a new port with this connection pool.

```
{
    "connection_uri": "postgres://{databasename}.db.upclouddatabases.com:11551/pool-1?sslmode=require",
    "database": "defaultdb",
    "pool_mode": "transaction",
    "pool_name": "pool-1",
    "pool_size": 10,
    "username": "upadmin"
}
```

If you have “Public access” enabled, the public connection pool URI will be the combination of the prefix public- + connection\_uri. For example:

```
"postgres://public-{databasename}.db.upclouddatabases.com:11551/pool-1?sslmode=require"
```

If you need to find the new connection\_uri at any time later, you can always query the pool by name.

```
GET /1.3/database/{uuid}/connection-pools/pool-1
```

You will then get the connection pool details in the response.

## Modifying connection pool

If you need to make changes to a connection pool, you can update the pool parameters with PATCH request with the parameters you want to change in the body.

```
PATCH /1.3/database/{uuid}/connection-pools/{pool_name}
```

```
{
  "database": "defaultdb",
  "pool_mode": "transaction"
  "pool_size": 20,
  "username": "upadmin"
}
```

In the response, you will then see the new details of your connection pool.

```
{
    "connection_uri": "postgres://{databasename}.db.upclouddatabases.com:11551/pool-4?sslmode=require",
    "database": "defaultdb",
    "pool_mode": "transaction",
    "pool_name": "pool-1",
    "pool_size": 20,
    "username": "upadmin"
}
```

## Deleting connection pool

Lastly, should you no longer need any given connection pool, you can delete a connection pool identified by name using the following request.

```
DELETE /1.3/database/{uuid}/connection-pools/{pool_name}
```

If you get no error, the name connection pool was deleted successfully. The delete command itself only returns a response status code 204 with no content.

## Summary

The UpCloud API makes it simple to create and manage your connection pools. Enabling a connection pool for PostgreSQL Managed Database can considerably improve your database throughput and save you money on your resource usage.

If you’d like to find out more about the UpCloud API and the related queries for Managed Databases, head over to our [API documentation](https://developers.upcloud.com/1.3/16-managed-database/) for the full specification.

UpCloud Managed Databases can also be configured using our Terraform module. Check out this guide on how to get started with [Managed Databases using Terraform](/docs/guides/managed-databases-terraform.md).
