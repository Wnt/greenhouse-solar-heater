# How to benchmark Managed Databases on UpCloud

Benchmarking managed database performance without a realistic workload can be difficult. While testing the database specifically for your use case would be ideal, setting up a replica of your production environment for comparison might be prohibitively time-consuming. Luckily, a simpler solution for this purpose exists, sysbench!

Sysbench is a popular command-line benchmarking tool for testing system and hardware performance. Originally designed to run CPU, memory and I/O tests, it’s also capable of benchmarking MySQL and PostgreSQL databases by generating synthetic traffic to your database systems.

It’s great for comparing the performance of different hardware, types of database nodes and even managed database offerings from cloud providers. In this guide, we’ll show you how to install the latest version of sysbench, how to generate test data and, of course, how to benchmark Managed Databases on UpCloud.

## Pre-requisitions

Start by setting up a new [Managed Database cluster](/docs/guides/set-up-upcloud-managed-databases.md) in a configuration you want to benchmark. If you already have an idea of your needs, choosing a configuration plan matching closest to your existing set-up would be a good starting point.

![Creating new Managed Database cluster](img/image.png)

Creating a new Managed Database cluster

You will also need to choose the host that will run the benchmarks. Generally, Managed Databases are intended to service Cloud Servers located within the same data centre using the private Utility network exclusive to your UpCloud account. So the next step is to [create a new Cloud Server](/docs/guides/deploy-server.md) for running the sysbench tests. Make sure both are in the same data centre.

![Creating new Cloud Server](img/image-1.png)

Creating a new Cloud Server

## Installing sysbench from source

Once you’ve created your Managed Database instance and a fresh Cloud Server, continue by [logging into the server using SSH](/docs/guides/connecting-to-your-server.md).

Next, we’ll install sysbench directly from the source. Although sysbench is readily available in most repositories, this version offers often lags behind the development. Therefore going straight for the source ensures you have the latest, most up-to-date version of the tool.

The main reason, in this case, is to allow us to use the sysbench option `--mysql-ssl=REQUIRED` to encrypt traffic and accurately simulate real use cases. This option is only available in sysbench version 1.1 and newer.

To start, install the required packages to build sysbench.

```
sudo apt-get install make automake libtool pkg-config libaio-dev libmysqlclient-dev libssl-dev -y
```

Then download the latest version from the sysbench GitHub repository.

```
git clone https://github.com/akopytov/sysbench
```

Next, change into the download directory and run the configuration scripts.

```
cd sysbench
./autogen.sh
./configure
```

Lastly, build and install sysbench onto your Cloud Server.

```
make -j
make install
```

```
Once complete, you can verify that the sysbench was installed successfully by checking for its version number.
sysbench --version
 sysbench 1.1.0-ead2689
```

## Generating test data

With sysbench installed, we can take a look at the included database benchmarking scripts. When installed from the source, the benchmark scripts can be found at the following location.

```
ls /usr/local/share/sysbench/

bulk_insert.lua oltp_delete.lua oltp_point_select.lua oltp_read_write.lua oltp_update_non_index.lua select_random_points.lua oltp_common.lua oltp_insert.lua oltp_read_only.lua oltp_update_index.lua oltp_write_only.lua select_random_ranges.lua
```

These LUA scripts are used to execute OLTP workloads on MySQL databases to simulate real-world use cases. OLTP stands for online transaction processing, which represents typical workloads for online applications such as e-commerce, order entry and financial transactions.

To start with, we’ll use the `oltp_read_only.lua` to generate test data in our Managed Database.

Note that the long commands here include a number of parameters you’ll need to set manually. It’s best to copy the example first into a text editor to fill in your connection details before copying the ready command to your terminal.

```
sysbench oltp_read_only
--mysql-host=hostname.db.upclouddatabases.com
--mysql-user=upadmin --mysql-password=password
--mysql-port=11550 --mysql-db=defaultdb
--mysql-ssl=REQUIRED --threads=40
--tables=40 --table-size=2000000 prepare
```

The above command includes the following parameters:

- `--mysql-host=hostname.db.upclouddatabases.com` to define your Managed Database host address. You can find this in your UpCloud Control Panel in the Databases section.
- `--mysql-user=upadmin` this sets the username used to access the database. The *upadmin* username is created by default and works fine for our needs.
- `--mysql-password=password` replace the password with yours to allow access. Check your database details at your UpCloud Control Panel.
- `--mysql-port=11550 --mysql-db=defaultdb` the port and database can be left unchanged unless you need to specify otherwise.
- `--mysql-ssl=REQUIRED` enforces connection encryption to simulate production use conditions.
- `--threads=40` allows sysbench to run queries in parallel to speed up things.
- `--tables=40` sets the number of database tables to be created. Note that fewer tables generally increase throughput but might not be representative of your use case.
- `--table-size=2000000` sets the number of rows per table. Together with the number tables, these define the amount of data generated.

Running this prepare command will open 40 concurrent connections to the Managed Database to create the tables. With a table size of 2 million rows like in our example above, we will get roughly 480 MB of data. Therefore, 40 tables with 2,000,000 rows each would then equate to about 19.2 GB of data. You should set the number of tables and table size accordingly to generate test data to fit your use case. If unsure, select values to generate roughly double the Managed Database node’s system memory for balanced results.

## Read test

Now that we’ve generated some test data, we can run the first database read benchmark. This can be done using the `oltp_read_only` script with much the same parameters as above while generating data. Below is an example command for a read-only test.

```
sysbench oltp_read_only
--mysql-host=hostname.db.upclouddatabases.com
--mysql-user=upadmin --mysql-password=password
--mysql-port=11550 --mysql-db=defaultdb
--threads=40 --tables=40 --table-size=2000000
--mysql-ssl=REQUIRED --range_selects=off
--db-ps-mode=disable --report-interval=1 --time=300 run
```

You’ll need to set the connection details and credentials to match your Managed Database instance. Besides the repeating parameters, you can find explanations of the new options on the list below.

- `--threads=40` defines the concurrency of the test queries. You should test out different values depending on your node configurations to determine at what point the Managed Database is fully utilised.
- `--tables=40` sets on how many data tables will be used for the benchmark. Note that fewer tables generally increase throughput but might not be representative of your use case.
- `--table-size=2000000` sets the number of rows per table that can be read. This should be set to match our generated data.
- `--mysql-ssl=REQUIRED` enforces connection encryption to simulate production use conditions.
- `--range_selects=off` enforces Primary Key lookups by disabling other types of SELECT operations.
- `--db-ps-mode=disable` disables prepared statements and tells sysbench to use regular queries.
- `--report-interval=1` sets the delay between status reports during the test measured in seconds.
- `--time=300` simply determines for how many seconds the test is run.

Once you run the command, you’ll see something like the example mid-test status report below.

```
[ 45s ] thds: 40 tps: 1514.26 qps: 18184.14 (r/w/o: 15153.62/0.00/3030.52) lat (ms,95%): 9.56 err/s: 0.00 reconn/s: 0.00
[ 46s ] thds: 40 tps: 1500.93 qps: 18016.19 (r/w/o: 15014.32/0.00/3001.86) lat (ms,95%): 10.46 err/s: 0.00 reconn/s: 0.00
[ 47s ] thds: 40 tps: 1445.11 qps: 17348.36 (r/w/o: 14458.14/0.00/2890.23) lat (ms,95%): 11.24 err/s: 0.00 reconn/s: 0.00
[ 48s ] thds: 40 tps: 1520.69 qps: 18233.34 (r/w/o: 15191.95/0.00/3041.39) lat (ms,95%): 9.56 err/s: 0.00 reconn/s: 0.00
[ 49s ] thds: 40 tps: 1492.26 qps: 17915.18 (r/w/o: 14930.65/0.00/2984.53) lat (ms,95%): 10.09 err/s: 0.00 reconn/s: 0.00
```

After the benchmark has finished, sysbench will print out the results like the example below.

```
SQL statistics:
    queries performed:
        read:                            4811160
        write:                           0
        other:                           962232
        total:                           5773392
    transactions:                        481116 (1603.65 per sec.)
    queries:                             5773392 (19243.77 per sec.)
    ignored errors:                      0      (0.00 per sec.)
    reconnects:                          0      (0.00 per sec.)

Throughput:
    events/s (eps):                      1603.6474
    time elapsed:                        300.0136s
    total number of events:              481116

Latency (ms):
         min:                                    3.96
         avg:                                   12.47
         max:                                  274.15
         95th percentile:                       22.69
         sum:                              5998809.01

Threads fairness:
    events (avg/stddev):           24055.8000/111.79
    execution time (avg/stddev):   299.9405/0.00
```

The main points to note from the results are **transactions** and **queries per second** as well as the **latencies** experienced during operations.

**Database queries** are requests to access, manipulate or retrieve data from the database. In this test, queries are mainly read operations and the number of queries per second gives an idea of how quickly the database is able to process the queries.

**Database transactions** symbolise a unit of work performed within a database management system manipulating the database independently of other transactions. The transactions per second show the average speed at which the database was able to complete transactions.

**Latency** indicates how long it took for the database to respond to a query. Sysbench reports the response times in milliseconds and counts the average. However, the number to pay attention to is the 95th percentile. This gives the best representation of the consistency of the response latencies as 95% of all queries were completed within this time.

## Write test

Benchmarking your Managed Database for write performance is also an important part of evaluating the service. If your application’s database usage is heavy on the right side, this might be the more important test for you.

You can run a writing test by using the `oltp_write_only` script with the following command.

Note that you’ll need to set the database details and credentials as before.

```
sysbench oltp_write_only
--mysql-host=hostname.db.upclouddatabases.com
--mysql-user=upadmin --mysql-password=password
--mysql-port=11550 --mysql-db=defaultdb
--threads=40 --tables=40 --table-size=2000000
--events=0 --time=300 --range_selects=off
--delete_inserts=10 --index_updates=10 --non_index_updates=10
--db-ps-mode=disable --report-interval=1 run
```

Once finished, the results might look something like the example below.

```
SQL statistics:
    queries performed:
        read:                            0
        write:                           2714840
        other:                           135742
        total:                           2850582
    transactions:                        67871  (226.21 per sec.)
    queries:                             2850582 (9500.62 per sec.)
    ignored errors:                      0      (0.00 per sec.)
    reconnects:                          0      (0.00 per sec.)

Throughput:
    events/s (eps):                      226.2052
    time elapsed:                        300.0418s
    total number of events:              67871

Latency (ms):
         min:                                   19.31
         avg:                                   88.41
         max:                                  894.92
         95th percentile:                      158.63
         sum:                              6000139.50

Threads fairness:
    events (avg/stddev):           3393.5500/20.56
    execution time (avg/stddev):   300.0070/0.01
```

The results include again the **transactions** and **queries per second** as well as the **latencies** experienced during operations. These show how many inserts per second your Managed Database can handle and at what commit latency.

## Mixed read and write test

Lastly, if your application does both reads and writes to the database, you can test both simultaneously by setting the weights of each type of query.

Use the `oltp_read_write` script along with the parameters below.

```
sysbench oltp_read_write
--mysql-host=hostname.db.upclouddatabases.com
--mysql-user=upadmin --mysql-password=password
--mysql-port=11550 --mysql-db=defaultdb
--threads=40 --tables=40 --table-size=2000000
--events=0 --time=300 --range_selects=off
--db-ps-mode=disable --report-interval=1 run
```

On completion, sysbench will print out the results.

```
SQL statistics:
    queries performed:
        read:                            2567310
        write:                           1026924
        other:                           513462
        total:                           4107696
    transactions:                        256731 (855.72 per sec.)
    queries:                             4107696 (13691.44 per sec.)
    ignored errors:                      0      (0.00 per sec.)
    reconnects:                          0      (0.00 per sec.)

Throughput:
    events/s (eps):                      855.7150
    time elapsed:                        300.0193s
    total number of events:              256731

Latency (ms):
         min:                                    5.46
         avg:                                   23.37
         max:                                  741.52
         95th percentile:                       41.10
         sum:                              5999340.05

Threads fairness:
    events (avg/stddev):           12836.5500/74.19
    execution time (avg/stddev):   299.9670/0.00
```

The results are similar to the previous runs with the exception of including both read and write queries. The **transactions** and **queries per second** as well as the **latencies** experienced during operations are still the main metrics. Check the ratio of reads and writes to see if it’s representative of your use case and adjust the parameters as needed.

## Cleaning up

When you are done benchmarking Managed Databases, you can remove any data generated by the test using the sysbench cleanup command. This can also be useful for resetting the database for another round of benchmarks with a different amount of data.

```
sysbench oltp_read_only
--mysql-host=hostname.db.upclouddatabases.com
--mysql-user=upadmin --mysql-password=password
--mysql-port=11550 --mysql-db=defaultdb
--tables=40 cleanup
```

Running the above command will have sysbench then connect to the database and drop the tables created by the prepare command or write tests.

## Summary

Sysbench is a versatile and dependable system benchmarking tool and it works great for benchmarking Managed Databases. With just a simple setup and a bit of time, you can gauge the performance of your Managed Database cluster.

These instructions also work on managed databases offered by other cloud providers allowing easy comparison between services. If you’d like to see how AWS RDS and DigitalOcean Databases stack up against UpCloud’s Managed Databases, check out our [blog where we put these database services through their paces](https://upcloud.com/blog/comparing-managed-databases-aws-digitalocean-upcloud/).
