# Cheatsheet for troubleshooting Linux servers with logs

This guide covers different methods for checking your server's logs for information and errors. Log checking helps you debug issues with applications, networks, and the operating system. The techniques described here work across all Linux distributions used on the [UpCloud platform](https://hub.upcloud.com/).

## System Logs

### Cloud-init

Cloud-init is the industry standard for initializing cloud servers. As the first process to run on a newly deployed server, it retrieves metadata from UpCloud and user data, such as initialization scripts, SSH keys, and network configuration. Do note that not all of our Linux templates utilize cloud-init. The following list shows the templates that don’t support cloud-init.

- Debian GNU/Linux 11 (Bullseye)
- Ubuntu Server 20.04 LTS (Focal Fossa)
- CentOS Stream 9
- AlmaLinux 8
- Rocky Linux 8

```
# Check cloud-init logs
cat /var/log/cloud-init.log

# While booting, cloud-init logs to two different files:
/var/log/cloud-init-output.log # Captures the output from each stage of cloud-init when it runs.

/var/log/cloud-init.log # Very detailed log with debugging output, describing each action taken.

# View cloud-init status
cloud-init status

# Debug data sources
cloud-init query --all

# Key directories for cloud-init
/etc/cloud/	# Configuration files
/var/lib/cloud/	# Runtime data
/var/cloud-init/	# Active runtime data
/var/log/cloud-init*	# Log files
```

### System Journal (systemd)

System Journal, also known as systemd, is the initialization system and service manager for modern Linux systems. It takes over the boot phase of the cloud server from cloud-init and manages the system startup process and services. Some key processes the system journal works with are monitoring and controlling resource usage by services, handling the mounting/unmounting of filesystems, and creating and managing control groups (cgroups).

The system journal utilizes the journalctl command to view cloud server logs. To view specific service statuses, such as Apache, you can use the systemctl command.

```
# View the complete system journal
journalctl

# View kernel messages
journalctl -k

# View logs since last boot
journalctl -f

# View logs for specific service
journalctl -u service-name

# Use journalctl -b to see previous boot logs, as by default it only shows the current boot.
journalctl -b -1
# View the previous boot numbers and the timestamp
journalctl -b --list-boots

# Service information
systemctl start service-name # Start a service
systemctl stop service-name # Stop a service
systemctl status service-name # Status of a service
```

Dmesg, similar to journalctl, is known as the diagnostic message and is an important tool for viewing kernel-related messages and hardware information. Important keys to note are that messages are stored in the kernel ring buffer, which can be limited and eventually overwritten. [Root privilege is needed for full access to the logs](/docs/guides/reset-root-password-cloud-server.md).

`# Hardware messages`
`dmesg`
`dmesg –level=err,warn # Show error and warning messages`
`Dmesg –facility=kern # Filter by facility (kern, user, mail, daemon, etc)`

## Traditional Log Files

Key log files in /var/log

```
# System logs
/var/log/syslog	# Debian/Ubuntu
/var/log/messages	# RHEL/CentOS

# Authentication Logs
/var/log/auth.log	# Debian/Ubuntu
/var/log/secure	# RHEL/CentOS
```

### syslog (/var/log/syslog or /var/log/messages):

General system activity log that captures everything unless it's directed elsewhere.
Contains boot messages, app behavior, system events, and scheduled tasks.
Search this for:

- Cron job failures or output
- System daemon startups/shutdowns
- Hardware detection issues
- Service failures without specific logs
- Kernel and driver messages

### messages (/var/log/messages):

Similar to syslog, but typically on Red Hat/CentOS systems
Non-debug, non-critical system events.
Search this for:

- Hardware issues
- Service start/stop events
- System resource issues
- General system behavior
- Network interface events

### auth.log (/var/log/auth.log):

Authentication events on Debian/Ubuntu systems
User logins/logouts, sudo usage, SSH access.
Search this for:

- Failed login attempts
- SSH brute force attacks
- Sudo command usage
- User session starts/ends
- PAM authentication issues

### secure (/var/log/secure):

Red Hat/CentOS equivalent of auth.log
Contains the same security and authentication data.
Search this for:

- Authentication failures
- Unauthorized access attempts
- Privilege escalation events
- SSH connection details
- Security-related messages

### Common search examples:

```
# Find failed SSH attempts
grep "Failed password" /var/log/auth.log

# Check sudo usage
grep "sudo" /var/log/auth.log

# Look for system errors
grep -i error /var/log/syslog

# Find service restarts
grep -i restart /var/log/messages
```

## Common Application Logs

Here are other log locations for common server software you might need to troubleshoot.

`# Application Logs`
`/var/log/apache2/ # Apache`
`/var/log/nginx # Nginx`
`/var/log/mysql # MySQL`

### MYSQL

For example, using `systemctl status mysql,` we can see that the service has failed to start.

```
● mysql.service - MySQL Community Server
     Loaded: loaded (/lib/systemd/system/mysql.service; enabled; vendor preset: enabled)
     Active: failed (Result: exit-code) since Tue 2025-02-04 09:23:45 UTC; 2min ago
    Process: 12345 ExecStartPre=/usr/share/mysql/mysql-systemd-start pre (code=exited, status=1/FAILURE)
   Main PID: 12346 (code=exited, status=1/FAILURE)
     Status: "Server startup in progress"

Feb 04 09:23:43 ip-172-31-24-156 systemd[1]: Starting MySQL Community Server...
Feb 04 09:23:44 ip-172-31-24-156 mysql-systemd-start[12345]: ERROR: The partition with /var/lib/mysql is too full!
Feb 04 09:23:45 ip-172-31-24-156 systemd[1]: mysql.service: Main process exited, code=exited, status=1/FAILURE
Feb 04 09:23:45 ip-172-31-24-156 systemd[1]: mysql.service: Failed with result 'exit-code'.
Feb 04 09:23:45 ip-172-31-24-156 systemd[1]: Failed to start MySQL Community Server.
```

Using the command `cat /var/log/mysql | grep ‘error’,` we can see any lines with ‘error’:

```
2025-01-31T00:42:51.152306Z 0 [ERROR] [MY-012639] [InnoDB] Write to file ./#innodb_redo/#ib_redo202_tmp failed at offset 0, 1048576 bytes should have been written, only 86016 were written. Operating system error number 28. Check that your OS and file system support files of this size. Check also that the disk is not full or a disk quota exceeded.
```

This log shows that the storage is at maximum capacity and needs to be increased.

### Apache2

Apache2 Troubleshooting:

Check Server Status & Logs

- Get service status: `systemctl status apache2`
- Error log: `/var/log/apache2/error.log`
- Access log: `/var/log/apache2/access.log`

Configuration Tests

- Run syntax tests for configuration files only: `apache2ctl -t`
- Show loaded modules: `apache2ctl -M`
- Check virtual hosts: `apache2ctl -S`

Common Apache Issues

- Permission problems: Check `/var/www` ownership and permissions
  - Permissions should be 755
  - Owner: read, write, execute (7)
  - Group: read, execute (5)
  - Others: read, execute (5)
- Ports conflict: `netstat -tulpn | grep :80`
- Memory issues: Check `top` or `htop` for memory usage
- SSL certificate errors: Verify paths in `/etc/apache2/sites-available/`

### NGINX

Server Status & Logs

- Check service status: `systemctl status nginx`
- Error log: `/var/log/nginx/error.log`
- Access log: `/var/log/nginx/access.log`

Configuration Tests

- The nginx checks the configuration for correct syntax and then tries to open files referred in the configuration: `nginx -t`
- Check config details: `nginx -T`
- Test with debug to view more detailed logs: `nginx -t -D DUMPCONFIG`

Common Nginx Issues

- 502 Bad Gateway: Check if the backend service is running.
- SSL issues: Verify certificate paths and permissions.

### SSL

Verify Certificate Files

- Check certificate locations: `/etc/ssl/certs/` and `/etc/ssl/private/`
- Verify file permissions: `ls -l /etc/ssl/private/your-cert.key`
- Ensure the private key is protected: should be 600 or 640
- Certificate files should be readable: 644

```
# Check certificate expiration
openssl x509 -in certificate.crt -noout -dates

# Check certificates expiration using a domain name
openssl s_client -connect domain.com:443 -servername domain.com 2>/dev/null </dev/null | openssl x509 -noout -dates

#Test SSL/TLS handshake given a domain name
openssl s_client -connect domain.com:443

# Verify certificate chain
openssl verify -CAfile chain.pem certificate.crt

# Test private key match
openssl x509 -noout -modulus -in certificate.crt | openssl md5
openssl rsa -noout -modulus -in private.key | openssl md5
```

Test SSL/TLS Connection

```
# Test SSL handshake
openssl s_client -connect your-domain.com:443 -servername your-domain.com

# Check supported protocols
nmap --script ssl-enum-ciphers -p 443 your-domain.com
```

Need help installing an application? [Check out our other tutorials.](/docs/guides.md)

## Tips to effectively parse logs using common Linux command-line tools:

- `grep` - Search for patterns in an unzipped file. *Use zgrep on compressed or gzipped files*.

```
# Basic search
grep "error" /var/log/syslog

# Case insensitive search
grep -i "warning" /var/log/nginx/error.log

# Show lines before and after match
grep -B 2 -A 2 "failed" /var/log/auth.log

# Search multiple files
grep "connection refused" /var/log/*.log

# Count matches
grep -c "404" /var/log/nginx/access.log

# Using grep with regex for multiple words per line.
grep -E 'word1|word2' /var/log/*.log
```

- `tail` - View end of files

```
# Last 10 lines
tail /var/log/syslog

# Follow file in real-time
tail -f /var/log/apache2/access.log

# Show last 100 lines
tail -n 100 /var/log/mysql/error.log

# Follow multiple files
tail -f /var/log/nginx/*.log
```

- `awk` - Pattern scanning

```
# Print specific columns
awk '{print $1, $9}' access.log

# Filter by value
awk '$9 == 404' access.log
```

- Combining commands for narrowing down a search.

```
# Find errors and sort by frequency
grep "error" logfile.log | sort | uniq -c | sort -nr

# Watch for specific IP
tail -f access.log | grep "192.168.1.1"

# Monitor response times over 5 seconds
tail -f access.log | awk '$NF > 5'
```

- `sed` - Stream editor for filtering

```
# Remove blank lines
sed '/^$/d' logfile.log

# Print lines between patterns
sed -n '/start/,/end/p' logfile.log

# Replace text
sed 's/error/ERROR/g' logfile.log

# "in-place" editing - it modifies the file directly. Without -i, sed prints changes to stdout (terminal) but doesn't modify the original file.
sed -i 's/word1/word2/g' logfile.log
```

- Additional Filters

```
# Time-based filtering
grep "2025-02-04" logfile.log

# Complex pattern matching
egrep "error|warning|critical" syslog

# Exclude patterns
grep -v "debug" application.log
```

### Disk/Storage usage

lsblk, also known as List Block Devices, shows block device hierarchy, displays disk and partition structure, and includes information about device sizes. It does not show disk usage or filesystem details.

df -,h also known as Disk Free - Human Readable, shows disk space usage, displays mounted filesystem usage, shows the percentage of space used, and provides readable size formats

In short, use `lsblk` for disk layout, `df -h` for space management.

```
# Disk space usage
df -h
lsblk
blkid

# Directory size
du -sh /path/to/directory

# I/O statistics
iostat -x 1

# Open files
lsof
```

Looking for a way to test your cloud servers' storage speeds? Check out our guide on [how to benchmark Cloud Servers](https://upcloud.com/resources/tutorials/how-to-benchmark-cloud-servers/).

### Network Information

```
# Network connections
netstat -tuln
ss -tuln

# Test network speed and packet loss
ping
traceroute
mtr

# Network interface statistics
ip -s link

# Show interface details (eth0, eth1, etc)
ip a

# Show server routes
ip r
ip route get [IP] # Check if server knows route to IP
```

### DNS

DNS is a topic that can have its guide, but we will briefly go over the basic setup.

DNS servers/resolvers are defined in the `/etc/resolv.conf` file. There are a variety of DNS resolvers you can use, including UpClouds! [More information about our DNS resolver](/docs/products/networking/dns.md)

To test your DNS resolution, you can use the following commands.

`# DNS resolution`
`dig domain.com`
`nslookup domain.com`

Dig, which stands for Domain Information Groper, is a newer and more powerful tool compared to nslookup. Dig will provide detailed DNS information, including query time, server used, and response size
It shows the full DNS response, including TTL, record class, and type. One key difference is that dig is still maintained, while nslookup is no longer maintained.

Here is an example output of dig:

```
; <<>> DiG 9.18.28-0ubuntu0.20.04.1-Ubuntu <<>> upcloud.com
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 51300
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; QUESTION SECTION:
;upcloud.com.                   IN      A

;; ANSWER SECTION:
upcloud.com.            300     IN      A       172.66.43.62
upcloud.com.            300     IN      A       172.66.40.194

;; Query time: 20 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
;; WHEN: Thu Feb 06 12:09:08 PST 2025
;; MSG SIZE  rcvd: 72
```

Here is an example of nslookup:

```
Server:         1.1.1.1
Address:        1.1.1.1#53

Non-authoritative answer:
Name:   upcloud.com
Address: 172.66.43.62
Name:   upcloud.com
Address: 172.66.40.194
Name:   upcloud.com
Address: 2606:4700:3108::ac42:2b3e
Name:   upcloud.com
Address: 2606:4700:3108::ac42:28c2
```

## Conclusions

This cheatsheet provides an overview of various methods and tools for troubleshooting issues on your cloud server by checking logs. From system-level logs like `cloud-init`, `systemd` via `journalctl`, and `dmesg`, to traditional log files `syslog`, `auth.log`, and application-specific logs for MySQL, Apache2, and Nginx, you have a handy list of easy commands for diagnosing common problems.

We also explored techniques for parsing these logs effectively using command-line tools such as `grep`, `tail`, `awk`, and `sed`, as well as commands for checking disk usage and network information. By systematically utilizing these tools and understanding where to look for relevant information, you can efficiently identify, debug, and resolve issues, ensuring the smooth operation of your Linux Cloud Servers.
