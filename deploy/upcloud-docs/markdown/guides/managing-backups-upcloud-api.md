# Managing backups using the UpCloud API

Backups are storage devices containing a point-in-time snapshot of your cloud server storage. Taking backups is a good way to preserve data when making system-critical changes or as assurance. A previous state of normal storage can be restored from any of its backups. Backups can also be cloned to create a new storage device. Backups are created either manually on-demand or automatically using the Simple Backups or Flexible backup schedule.

This article explains how the backup functions can be used by employing the UpCloud API authenticated with your Base64 encoded credentials. If you are not yet entirely familiar with the usage of the API, take a look at our guide about [getting started with UpCloud API](/docs/guides/getting-started-upcloud-api.md).

## Enabling Simple backup

Simple Backup is the easiest way of setting up an expert-level backup schedule for any Cloud Server running General Purpose, High CPU or High Memory plans. It is the best place to start configuring a reliable backup method to ensure the safety of your business-critical data.

Simple Backup can be enabled with an easy API query to modify the server details. Set the `simple_backup` with the time in UTC `0000-2359` for when you wish the backup to be made, followed by your selected plan `dailies|weeklies|monthlies`. Replace the <server\_UUID> with the unique identity of your Cloud Server. Below is an example of enabling the Week plan for daily backups.

```
PUT /1.3/server/<server_UUID>
```

```
{
    "server" : {
        "simple_backup": "0430,dailies"
    }
}
```

Disabling the Simple Backup plan can likewise be done with a single API query by setting the `simple_backup` as `no`.

```
PUT /1.3/server/<server_UUID>
```

```
{
    "server" : {
        "simple_backup": "no"
    }
}
```

That’s it, quick and easy.

## Setting up automated Flexible backups

Configuring an automated backup schedule works by modifying a storage device to add a `backup_rules` segment with a PUT request. These rules define how often a backup is taken, at what time of the day should the backup be stored, and how long each backup is kept before automated deletion. The following parameters are accepted in the backup rules.

```
"interval": "daily / mon / tue / wed / thu / fri / sat / sun"
"time": "0000-2359"
"retention": "1-1095"
```

The example backup rule below will set up a weekly backup taken every Saturday morning at 4:30 and retained for 8 days.

```
PUT /1.3/storage/<storage_UUID>
{
    "storage": {
        "backup_rule": {
            "interval": "sat",
            "time": "0430",
            "retention": "8"
        }
    }
}
```

The currently active backup rules will show up in the storage details.

```
GET /1.3/storage/<storage_UUID>
```

## Creating on-demand backup

Taking an on-demand backup is fast and simple. The following POST request allows you to create a new backup disk of a specific storage device identified by the storage UUID. Include a title in the body of the request, as shown in the example below, to give a name or description of the backup device.

```
POST /1.3/storage/<storage_UUID>/backup
{
    "storage": {
        "title": "Manually created backup"
    }
}
```

In response to a successful operation, you will get the details of the new backup storage.

## Restoring a backup

The main method of restoring backups is, in essence, reverting the storage disk back to the same state it was when the backup was taken.

You can get a list of all of your backup storage with the GET request below.

```
GET /1.3/storage/backup
```

When restoring a backup, the server that the origin storage is attached to must first be shut down and in the `stopped` state. To find out the correct server UUID, use the following GET request with the storage UUID, as indicated by the origin in the backup, to fetch the full details of the disk you wish to restore.

```
GET /1.3/storage/<storage_UUID>
```

```
{
    "storage": {
        ...
        "servers": {
            "server": [
                "00e46b2e-0909-4e77-8acb-4b21e75cb5b9"
            ]
        },
        ...
    }
}
```

Then stop the server in preparation for the restore.

```
POST /1.3/server/<server_UUID>/stop
```

Once the server has been powered down, use the following POST request while replacing the <backup\_UUID> with the UUID of the backup you wish to restore.

```
POST /1.3/storage/<backup_UUID>/restore
```

Restoring a backup will only take a moment depending on the size of the storage device. Once completed, you can restart the server again with the storage disk reverted to the backup state. Although the initial restore is fast, the new storage state must finish a background synchronisation before further actions, for example taking a new backup, can be made.

## Cloning a new disk from a backup

Sometimes you might not want or be able to shut down the server the origin storage is attached to, yet you would need to get access to the files stored in a backup. This can be done by cloning the backup disk to create an entirely new storage device.

Backup disks are treated much the same as any other storage device. You can clone any backup storage using the following POST request.

Take care when choosing the target zone for cloning a storage disk. While cloning within one zone is quick, operations between different zones can be time-consuming.

```
POST /1.3/storage/<backup_UUID>/clone
{
    "storage" : {
        "zone" : "fi-hel1",
        "tier" : "maxiops",
        "title" : "Clone of a backup disk"
    }
}
```

The response will return the details of the new cloned storage device, such as its UUID. Then to access the backup files, attach the new disk to an existing server or deploy a new host using the storage disk instead of a public template.

## Summary

Managing your backups using the UpCloud API is really quite simple and easy to implement in any programming language with support for HTTP libraries. Check out the full [API Documentation](https://developers.upcloud.com/) to learn more about the features the UpCloud API offers.
