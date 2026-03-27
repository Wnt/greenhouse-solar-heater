# Troubleshooting Cloud Servers

## First aid for any server issues

When troubleshooting a server issue, begin by assessing its core health indicators:

- CPU and memory usage: Use the `top` command to check resource bottlenecks.
- Disk space: use the `df -h` command to examine disk space usage.
- Network connectivity: Use `ping 8.8.8.8` to verify the server's connection to the public network.
- DNS resolution: Use `host upcloud.com` to confirm that DNS resolution is functioning correctly.

Always take backups before making any changes

Snapshot backups provide a quick and easy way to revert to a previous state.

## Troubleshooting and recovery tools

- **Server logs:** Examine logs in `/var/log`, particularly `syslog`, for error messages and other clues.
- **Server console:** Access the server console (similar to connecting a monitor) for low-level output and local logins, bypassing network issues.
- **Reboot:** A simple reboot often resolves transient problems.
- **Utility network connection:** If the server is inaccessible from the public internet, try connecting through the [Utility network](/docs/products/networking/utility-network.md) from another Cloud Server within the same account.
- **Restore from backup:** If [automatic backups](/docs/products/block-storage/backups.md) are enabled, restore the server to a previous working state.
- **Firewall check:** Verify that firewall aren't blocking necessary connections - both [UpCloud Firewall](/docs/products/networking/firewall.md) and software firewall on the server itself.
- **Audit logs:** Review [Audit logs](/docs/getting-started/accounts/audit-logs.md) to track changes made to associated resources.
- **Live CD boot:** Attach a live CD image and boot from it to for advanced debugging of boot issues.
- **Attach storage to another server:** [Attach storage devices](/docs/products/cloud-servers/storage.md) to another server in the same location for analysis and repair.
- **Server reinstallation:** As a last resort, reinstall the operating system. Warning: This will erase all data on the OS disk.

## Common issues

This is a non-exhaustive list of common issues on Linux servers, with tips for further troubleshooting.

### DNS resolution issues

> It's not DNS
> There's no way it's DNS
> It was DNS
>
> - DNS Haiku

As the DNS Haiku suggests, DNS is often the root of server woes. Verifying that the server is reachable by its hostname and that internal DNS resolution works correctly should be a primary troubleshooting step for any server issue.

DNS resolution can be tested from the server by querying a hostname from the DNS:

```
# host upcloud.com
upcloud.com has address 172.66.43.62
upcloud.com has address 172.66.40.194
upcloud.com has IPv6 address 2606:4700:3108::ac42:2b3e
upcloud.com has IPv6 address 2606:4700:3108::ac42:28c2
```

If DNS resolution fails, the DNS server may be unresponsive (suggesting a broader network issue) or improperly configured. To check the DNS configuration, examine the `/etc/resolv.conf` file. This file specifies the nameservers the server uses.

```
# cat /etc/resolv.conf
nameserver 94.237.127.9
nameserver 94.237.40.9
```

The DNS configuration is typically managed by the DHCP service, which runs at server startup to acquire IP addresses and configure routing and DNS settings.

Keep in mind that DNS is a distributed system with multiple layers of caching. Changes can take anywhere from minutes to hours to propagate fully to all DNS servers.

**Suggested solutions:**

- Check and fix DNS resolver settings in `/etc/resolv.conf`.
- Reset the server's networking by rebooting the server.

### Server unreachable

A server can become completely unresponsive due to network issues within the server itself or broader internet connectivity problems.

To diagnose network problems, use `ping` to check for packet loss. `traceroute` or `mtr` can be used to trace the network route and identify potential bottlenecks between your location and the server.

**Suggested solutions:**

- Check that the server is working normally using the server console.
- Try to connect to the server from another network, i.e. home or work network.
- Try to connect to the server through the Utility network using its Utility network IP.
- Reboot the server to reset network configuration.

### Lost password or SSH key

A lost password or SSH key can prevent access to an otherwise functional server. Recovery requires accessing the server through a backdoor, either by booting from a rescue CD or by detaching the operating system disk and attaching it to another server. Once attached, the disk can be mounted (e.g., `mount /dev/vdb /mnt`), making the filesystem accessible under `/mnt`.

SSH keys for the root user are stored in `root/.ssh/authorized_keys`, which can be edited directly.

A password can be changed using chroot: `chroot /mnt`, then `passwd` to change the root password, followed by `exit` to exit the chroot environment.

Finally, remember to unmount the disk with `umount /mnt`.

**Suggested solutions:**

- Boot the server from a rescue CD-ROM media, mount the disk and reset the password or SSH key.
- Detach and attach the operating system disk to another server, mount the disk and reset the password or SSH key.
- Follow our guides with fully detailed steps for resetting your password on [Linux](/docs/guides/reset-root-password-cloud-server.md) or [Windows](/docs/guides/reset-windows-administrator-password.md) servers.

### Storage full

Server storage is often consumed by application data or logs, which can lead to applications failing to start or function correctly. Use the `df` command to display overall disk usage:

```
# df -h
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        99G   90G  8.9G  91% /
```

The server's primary storage device is typically attached as `/dev/vda1`. A server should have at least 20% free disk space in reserve. To locate the directories with the most disk space usage, use the `du` command:

```
# du -hs /*
13M     /bin
121M    /boot
12M     /etc
6.9G    /home
947M    /lib
4.1G    /root
1.6M    /run
18M     /sbin
52K     /tmp
3.1G    /usr
75G     /var
```

The system might also run out of avaialble inodes before running out of disk space. Inodes are used to allocate metadata for files in a filesystem, and can be exhausted if the system stores a large number of small files. Inode utilisation can be examined with the `df` command:

```
# df -i
Filesystem      Inodes  IUsed   IFree IUse% Mounted on
/dev/vda1      5836800 186504 5650296    4% /
```

**Suggested solutions:**

- Remove unnecessary files.
- Make sure logs are rotated, and old logs are compressed.

### Server is slow

A server's slow response can stem from several causes:

- **CPU overload:** Server applications may be consuming all available CPU cores. Use `top` to monitor CPU usage. The `id` (idle) column indicates the percentage of unused CPU capacity. A consistently low idle value suggests high CPU utilisation.
- **Insufficient memory:** Limited available memory frequently causes server slowdowns. Use `free -m` to display current memory usage in megabytes. Pay attention to the `available` memory.
- **High I/O wait:** Intensive storage operations can exhaust available storage bandwidth, particularly during heavy read/write activity or a high volume of individual storage transactions. High I/O wait manifests as a high `wa` value in the `top` output.
- **Full storage:** A full file system can severely impact performance or cause unresponsiveness in applications that require write access. Check disk space usage with commands like `df -h`.
- **DNS resolution issues:** Slow or unresponsive DNS resolution can hinder outbound network connections.
- **Network instability:** Degraded network connections can also lead to slow server responses. Use `ping` to check for packet loss, ideally from multiple locations: one distant (across the internet) and one nearby (within the same data center). This helps isolate network issues.

**Suggested solutions:**

- Debug any applications consuming too many resources.
- Ping the server from multiple locations, check for packet loss.
- Distribute the load across multiple servers by moving data and applications.
- Resize the server.

### Server does not boot properly

A server's failure to boot normally, with error messages displayed on the console, often points to critical issues. Here are some common causes and troubleshooting steps:

- **Bootloader issues:** A corrupted or misconfigured bootloader prevents the operating system from loading. Reinstalling the bootloader using a rescue disk or installation media is typically required.
- **File system corruption:** Damage to the root file system can halt the boot process. Attempting repair with `fsck` (file system check) or other file system repair tools is often the next step. If `fsck` fails or reports unrecoverable errors, restoring from backups might be necessary.
- **Missing or incorrect configuration files:** Essential configuration files might be missing, corrupted, or contain incorrect settings, preventing the OS from starting. Reviewing system logs and configuration files (e.g., `/etc/fstab` for file system mounting) can help identify the problem.

**Suggested solutions:**

- Reinstall the boot loader with a rescue CD.
- Revert to a backup.
- Reinstall the server, copy data by attaching the storage to another server.

### Kernel panic

A kernel panic occurs when the operating system kernel, the core of the system, encounters a fatal error from which it cannot recover. The server console will display a message indicating a `kernel panic`," often accompanied by diagnostic information.

**Suggested solutions:**

- Reboot the system.
- Install operating system patches.

### Compromised server

A compromised (or "rooted") server signifies unauthorized access, granting an attacker control. These compromised systems are often exploited for malicious purposes, including data theft, sending spam, and participation in denial-of-service (DoS) attacks. A common attack vector involves exploiting vulnerabilities in public-facing applications like WordPress on servers lacking up-to-date security patches. Attackers often attempt privilege escalation after initial access to gain root or administrator-level privileges.

A server compromised with successful privilege escalation should be considered irrevocably corrupted. Reinstalling the entire operating system is the only reliable way to ensure the system's integrity. Attempting to "clean" a compromised server is highly discouraged, as backdoors and rootkits can be extremely difficult to detect and remove completely. Reinstallation is the most secure and efficient approach.

**Suggested solutions:**

- Reinstall the compromised server application.
- Keep the server up-to-date with security updates for the operating system and all applications.
- Reinstall the server and move data from the old server.
