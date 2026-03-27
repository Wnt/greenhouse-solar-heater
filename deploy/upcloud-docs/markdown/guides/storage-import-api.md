# How to upload data using the Storage Import API

If you are looking to migrate to UpCloud or want to use your own media, get started quickly using Storage Import. The Storage Import API allows you to easily import installation media or even entire virtual machine images.

Migrate servers from on-premise or any other cloud quickly and easily by simply creating new storage out of your server image and deploying it to a cloud server.

## How Storage Import Works

Storage Import creates a new installation media or server storage out of any system or server image available online by fetching the requested file and uploading it onto a new storage device. It can be useful for migrating existing server images from on-premise hosting or from other cloud providers.

Storage Import is also handy for using custom installation media if your favourite Linux distribution is not yet available as a public template or ready-made install disk.

Supported file types:

- RAW storage images
- IMG storage images
- ISO archive files
- GZIP (extension .gz, content-type must be set to application/gzip when uploading via API or curl)
- XZ (extension .xz, content-type must be set to application/x-xz when uploading via API or curl)

> **Important**: When uploading compressed images(GZIP or XZ), the content-type header must match the compression format

The target storage needs to be free and not in operation, either;

- detached from any cloud server
- if attached, the cloud server needs to be shutdown
- not in a maintenance state

Note that the system image or installation media you wish to upload needs to be made available for download for Storage Import to be able to retrieve it. The process supports the use of HTTPS and Basic Auth for secure upload.

## Setting password protection using Basic Auth

We recommend using Basic Auth password protection when preparing files and images for import. This needs to be done on the webserver that is hosting your files and the steps will differ depending on the operating system and web server in use. Here we’ve outlined some of the options you have for setting password protection on files and folders on your web server.

Start by installing Apache2 utils. The utils package includes a password generator tool which we’ll be using to encode the credentials.

```
sudo apt install apache2-utils
```

Afterwards, continue below with the instructions applicable to your web server.

### Apache2

Generate a password file using the htpasswd command as shown below. Replace `<username>` with whatever you want to use. On running the command, you will be asked to set the password, and enter it twice when prompted.

```
sudo htpasswd -c /etc/apache2/.htpasswd <username>
```

```
New password:
Re-type new password:
Adding password for user <username>
```

Next, edit your site configuration. The file name will differ depending on your set up but it’s generally stored in /etc/apache2/sites-available/ and ends in .conf file type notation.

```
sudo nano /etc/apache2/sites-available/<example>.conf
```

Once you’ve opened the file for editing, add the following authentication parameters as shown below if not already present. You may need to add the `<Directory "/path/to/html">` segment if your configuration does not contain one. You can set the path to your webroot to enable authentication site-wide.

```
VirtualHost *:80>
    ...
    <Directory "/var/www/html">
        AuthName "Restricted"
        AuthType Basic
        AuthBasicProvider file
        AuthUserFile "/etc/apache2/.htpasswd"
        Require valid-user
        ...
    </Directory>
```

Alternatively, if you want to only enable authentication for a specific folder, set the directory with the path to the folder containing your private files. Otherwise include the same parameters.

```
VirtualHost *:80>
    ...
    <Directory "/var/www/html/<files>">
```

When done, save the file and exit the editor.

Then reload the webserver.

```
sudo systemctl reload apache2
```

Done! You should now be prompted for credentials when browsing to the password-protected URL.

### Nginx

We’ll use the *htpasswd* installed above also with nginx web servers. Run the following command to generate a password file. Replace `<username>` with whatever you wish. When running the command, you will be asked to set the password, and enter it twice when prompted.

```
sudo htpasswd -c /etc/nginx/.htpasswd <username>
```

```
New password:
Re-type new password:
Adding password for user <username>
```

Once you’ve generated the password file, you’ll need to set it in your web server configuration file. The file name will differ depending on your website but it’s generally stored in `/etc/nginx/sites-available/` and ends in `.conf` file type notation.

```
sudo nano /etc/nginx/sites-available/<example>.conf
```

With the website configuration open for edit, set enable authentication by adding the two parameters as shown below. Adding these two lines directly to the server section will enable password protection for the whole site.

```
server {
        ...
        auth_basic "Restricted access";
        auth_basic_user_file /etc/nginx/.htpasswd;
        ...
```

Alternatively, you can include the authentication parameters within a location segment to set the password for a specific directory.

```
server {
        ...
        location /<files> {
                auth_basic "Restricted access";
                auth_basic_user_file /etc/nginx/.htpasswd;
        }
        ...
```

Once done, save the file and exit the editor.

You can test that the syntax is correct before applying the changes by using the next command.

```
sudo nginx -t
```

```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

If you get a confirmation such as the one shown above, you are ready to enable the new configuration by reloading the nginx service.

```
sudo systemctl reload nginx
```

That’s it! Your files are now set to require authentication to access and be safe from prying eyes.

### Accessing password-protected files

When fetching password-protected files, add your credentials at the beginning of the URL separated from the rest by an @ sign.

```
https://username:[email protected]/files/system.img
```

Storage Import should then be able to access your target file and begin uploading it.

## Create new storage for import

The UpCloud API allows users to run programmable requests to manage and operate their cloud resources. It’s a quick way to get started by using the Storage Import API with just a couple of commands instead of going through the steps in the control panel.

If you are not yet familiar with the UpCloud API, learn more in our [getting started guide](/docs/guides/getting-started-upcloud-api.md).

### Create new storage for import

First, you will need a storage device of the same size or larger than the file you want to import. If you do not already have free storage, create a new one with the following request.

```
POST /1.3/storage/
```

```
{
  "storage": {
    "size": "10",
    "tier": "maxiops",
    "title": "storage-import",
    "zone": "fi-hel1"
  }
}
```

When done, you’ll see a response similar to the example below. Note down your storage UUID as you will need it for the other API operations.

```
{
   "storage": {
      "access": "private",
      "backup_rule": {},
      "backups": {
         "backup": []
      },
      "license": 0,
      "servers": {
         "server": []
      },
      "size": 10,
      "state": "online",
      "tier": "maxiops",
      "title": "import-test-ubuntu-20-04",
      "type": "normal",
      "uuid": "0108427c-aff8-4ce9-9897-849fb89feae0",
      "zone": "fi-hel1"
   }
}
```

Once you have a suitable storage device available, continue with one of the two import methods below.

## Create Storage Import

The Storage Import API offers two methods for importing data: **HTTP import** or **direct upload**. Depending on your file size and where it’s stored, you may wish to use one over the other.

It’s also possible to [use Storage Import via the UpCloud Control Panel](/docs/guides/storage-import.md).

**HTTP Import** is used to upload files made available on a web server. This is often more convenient for uploading larger files such as storage images between cloud servers. It can also be used to upload installation media directly from the OS provider’s download link.

**Direct upload** allows uploading straight from your local computer without the need for setting up a web server. This requires the use of a tool such as curl to run the upload and which needs to remain open until the import has finished.

### HTTP Import

When you have a storage device ready for import, begin the upload by sending the following request. Set the UUID of your target storage device in the request and the URL of the file you want to import in the body text as shown in the example below.

```
POST /1.3/storage/{uuid}/import
```

```
{
  "storage_import": {
    "source": "http_import",
    "source_location": "https://username:[email protected]/files/system.img"
  }
}
```

On successful request, you’ll see a response similar to the following example. The initial state of the upload will show preparing or prepared.

```
{
   "storage_import": {
      "client_content_length": 0,
      "client_content_type": "",
      "completed": "",
      "created": "2020-06-23T19:13:15Z",
      "error_code": "",
      "error_message": "",
      "md5sum": "",
      "read_bytes": 0,
      "sha256sum": "",
      "source": "http_import",
      "source_location": "https://[REDACTED]@example.com/files/system.img",
      "state": "prepared",
      "uuid": "0747a8c1-3a34-4908-925e-9ef9a369af51",
      "written_bytes": 0
   }
}
```

The import operation will then commence granted the URL you submitted is accessible.

### Direct upload

To begin direct upload, use the following request to create the import task. Set the UUID of your target storage device in the request and the source as `direct_upload` like in the example underneath.

```
POST /1.3/storage/{uuid}/import
```

```
{
  "storage_import": {
    "source": "direct_upload"
  }
}
```

You will then see a response such as an example output below. The response includes the `direct_upload_url` that can be used to start the upload itself.

```
{
   "storage_import": {
      "client_content_length": 0,
      "client_content_type": "",
      "completed": "",
      "created": "2020-06-26T16:06:59Z",
      "error_code": "",
      "error_message": "",
      "md5sum": "",
      "read_bytes": 0,
      "sha256sum": "",
      "source": "direct_upload",
      "direct_upload_url": "https://fi-hel1.img.upcloud.com/uploader/session/0747a8c1-3a34-4908-925e-9ef9a369af51",
      "state": "prepared",
      "uuid": "0747a8c1-3a34-4908-925e-9ef9a369af51",
      "written_bytes": 0
   }
}
```

You can then import files straight from your local computer by using the direct upload method. Note that the link will expire after 10 minutes if the direct upload is not started.

```
curl --data-binary @/path/to/files/system.img --fail -XPUT https://fi-hel1.img.upcloud.com/uploader/session/0747a8c1-3a34-4908-925e-9ef9a369af51
```

When using something other than raw images (for example, a gzipped image), you need to also supply the Content-Type header.

```
curl -H 'Content-Type: application/gzip' --data-binary @/path/to/files/system.img.gz --fail -XPUT https://fi-hel1.img.upcloud.com/uploader/session/0747a8c1-3a34-4908-925e-9ef9a369af51
```

Once the upload has finished, you’ll see an output similar to the example underneath.

```
{
   "written_bytes":9521070080,
   "md5sum":"f03d31c11136e24c10c705b7b3efc39f",
   "sha256sum":"caf3fd69c77c439f162e2ba6040e9c320c4ff0d69aad1340a514319a9264df9f"
}
```

That’s it! The data you imported is then available on the target storage devices for you to use as you wish.

Storage Import status
The import process will take time depending on the size of the file and the speed of the network connectivity. Especially system storage images are often large and require more time to upload.

You can check the state of the process using the following request. Set the UUID of your import storage device in the request URL.

```
GET /1.3/storage/{uuid}/import
```

The response will show the current state of the importing process and the progress made in writing to the storage so far.

```
{
   "storage_import": {
      "client_content_length": 10737418240,
      "client_content_type": "",
      "completed": "",
      "created": "2020-06-23T19:15:57Z",
      "error_code": "",
      "error_message": "",
      "md5sum": "",
      "read_bytes": 1661214003,
      "sha256sum": "",
      "source": "http_import",
      "source_location": "https://[REDACTED]@example.com/files/system.img",
      "state": "importing",
      "uuid": "0734ad68-e715-4687-89c5-774d708b9515",
      "written_bytes": 1661214003
   }
}
```

Feel free to check the import status again later to see how the operation is progressing.

Cancelling Storage Import
When the upload is started via the Storage Import API to a stand-alone storage device, the process will continue in the background without interruption to other operations.

However, if you wish to stop the import, you can cancel the operation using the following API request. Set the UUID of your import storage device in the request URL.

```
POST /1.3/storage/{uuid}/import/cancel
```

You will then get a response something along the lines of the example underneath. The state of the import will first show cancelling.

```
{
   "storage_import": {
      "client_content_length": 10737418240,
      "client_content_type": "",
      "completed": "2020-06-23T19:19:09Z",
      "created": "2020-06-23T19:15:57Z",
      "error_code": "CLIENT_FAILURE",
      "error_message": "import task was cancelled",
      "md5sum": "6b2bfc737ef922f47ed4751d474170c6",
      "read_bytes": 2494455091,
      "sha256sum": "19567e0a4c83ae010c35fa094e5832e09ac20655912141138df38354ef51d030",
      "source": "http_import",
      "source_location": "https://[REDACTED]@example.com/files/system.img",
      "state": "cancelling",
      "uuid": "0734ad68-e715-4687-89c5-774d708b9515",
      "written_bytes": 2494455091
   }
}
```

After cancelling, the storage device will return to the normal online state and again allow new storage import or other requests.

## Making use of new storage

Once your import has finished, you can put the new storage device to use the way you wish.

### Storage image with a boot partition

If your storage image contains a boot partition, you can set it as the main device for a standalone cloud server.

Depending on your system storage and the previous networking setup, you may not have network access out of the box. You can use the web console at your UpCloud Control Panel or any VNC viewer to [reach your cloud server](/docs/guides/connecting-to-your-server#console-connection.md) to restore connectivity.

The default network interfaces on our cloud servers include the following:

- Public IPv4 for internet access
- Private utility network
- Public IPv6 network connection

If you do not need all of the default network interfaces, you can detach unwanted networks to simplify your setup. Then [configure the network connection](/docs/guides/attaching-new-ip-addresses.md) you want to use.

### File storage

Storage images that contain a file system can be mounted to any cloud server to access the files. Uploaded storage will work much the same as any other storage device allowing you to [mount it at the directory point](/docs/guides/adding-removing-storage-devices.md) you wish.

### Installation media

If you uploaded [installation media](/docs/guides/using-own-install-media.md), change the boot order to select CDROM as the first device and get started with the installation process at the next startup.
