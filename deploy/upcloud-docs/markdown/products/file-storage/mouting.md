# Mounting File Storage shares

## Prerequisites

Before mounting a File Storage share, ensure the following requirements are met:

### Network configuration

- Cloud Servers must be connected to the same [SDN Private Network](/docs/products/networking/sdn-private-networks.md) as the File Storage instance.
- Servers must be within a subnet that has been [granted access](/docs/products/file-storage/access-control.md) to the specific share.
- Network connectivity should be verified between servers and the File Storage instance.

### Firewall and port configuration

NFS communication requires specific ports to be open. Ensure the following traffic is allowed:

- **NFS port**: TCP/UDP port `2049` for NFS data transfer

### Share access configuration

- The File Storage share must be configured with appropriate access permissions for your server's subnet.
- Verify that the share has been created and is available through the File Storage management interface.
- Check that your server's IP address falls within the allowed subnet range for the share.

## Required software

You need to install NFS client utilities on your Cloud Server. The required packages vary by operating system:

### Ubuntu / Debian

```
sudo apt update
sudo apt install nfs-common
```

### CentOS / Rocky Linux / AlmaLinux

```
sudo yum install nfs-utils
```

### Verification

After installation, verify the NFS client is ready:

```
showmount -e <file-storage-ip>
```

## Temporary mount

To mount a File Storage share temporarily (mount will not persist after reboot):

1. Create a mount point directory:

   ```
   sudo mkdir -p /mnt/file-storage
   ```
2. Mount the share using the NFS server IP and share path:

   ```
   sudo mount -t nfs <file-storage-ip>:/<share-name> \
    -o vers=4.1,nconnect=8,rsize=1048576,wsize=1048576,noatime,hard \
    /mnt/file-storage
   ```
3. Verify the mount:

   ```
   df -h /mnt/file-storage
   ls -la /mnt/file-storage
   ```

Temporary mounts are useful for:

- Testing connectivity before making permanent changes
- One-time data transfers or migrations
- Development and troubleshooting scenarios

## Permanent mount

To configure a File Storage share to mount automatically at boot time, add an entry to `/etc/fstab`:

1. Create the mount point:

   ```
   sudo mkdir -p /mnt/file-storage
   ```
2. Edit `/etc/fstab` and add the mount entry:

   ```
   <file-storage-ip>:/<share-name>  /mnt/file-storage  nfs  defaults,_netdev,vers=4.1,nconnect=8,rsize=1048576,wsize=1048576,noatime,hard  0  0
   ```
3. Test the fstab entry without rebooting:

   ```
   sudo mount -a
   ```
4. Verify the mount persists:

   ```
   df -h /mnt/file-storage
   ```

## Recommended mount options

For optimal performance, reliability, and data integrity, use the following NFS mount options:

vers=4.1,nconnect=8,rsize=1048576,wsize=1048576,noatime,hard

- **vers=4.1**: Use NFSv4.1 protocol for performance and security
- **nconnect=8**: Use 8 parallel connections to the File Storage instance
- **rsize=1048576**: Read buffer size of 1 MB for improved read performance
- **wsize=1048576**: Write buffer size of 1 MB for improved write performance
- **noatime**: Avoid file access time updates reducing the amount of NFS traffic
- **hard**: Retry indefinitely on NFS errors (prevents data corruption)
- **\_netdev**: Wait for network before mounting (required for /etc/fstab)
