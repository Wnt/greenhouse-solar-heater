# Taking backups

The UpCloud Control Panel offers three methods of taking backups of your Cloud Servers – easy-to-use Simple Backups, custom-scheduled Flexible backups, and instant on demand backups. Each of these is configured on a per-server basis at your [UpCloud Control Panel](https://hub.upcloud.com/) in the server settings under the Backups tab.

![Server settings backups](img/image.png)

Note that all backups are stored in the same data centre as the origin Cloud Server to enable fast restore. You can arrange offsite backups manually, for example, by [cloning](/docs/guides/server-cloning#cloning-storage-device-backups.md) backups to a different location for disaster recovery.

## Simple Backups

Simple backup is the easiest way of setting up an expert-level backup schedule for any Cloud Server plan. It is the best place to start configuring a reliable backup method to ensure the safety of your business-critical data.

Get started by going to the Backups tab in the cloud server settings at your [UpCloud Control Panel](https://hub.upcloud.com/).

In the first section, you’ll see the options for Simple backups:

- Day plan with 1 daily backup
- Week plan with 7 daily backups
- Month plan with 4 weekly backups + 7 daily backups
- Year plan with 12 monthly backups + 4 weekly backups + 7 daily backups

Select the plan you wish according to the number of backups and retention period you want.

Next, pick a time of the day for the backup most convenient to your cloud server or use the default.

Then click the *Save* button to confirm.

![Scheduled backups simple](img/image-1.png)

That’s it! The first backup will be taken at the next scheduled time.

If you wish to take a backup immediately, have a look at the section below about on demand backups.

## Flexible backups

If you have multiple storage devices that contain important data with different frequencies in changes, consider scheduling Flexible backups. They offer an automated option for keeping a version of your storage just in case you might need to restore a file or even roll back the whole storage device.

Turn on Flexible backups by doing the following:

- Select the storage disks that should be backed up each time
- Choose the frequency of the backups, daily or specific day of week
- Set the time of the day the backup is saved
- Choose the duration after which the backup is automatically deleted
- And finally, click the Save button to confirm the changes.

![Scheduled backups flexible](img/image-2.png)

Be sure to select an appropriate schedule for the automatic deletion to avoid keeping unnecessary backups of the same data. All storage, including each backup, is priced by the storage size, so optimising the backup retention can help save on costs. See more about the backup pricing below.

Note that manual backups are excluded from the automatic deletion feature which allows you to make important backups for safekeeping. These can be done manually when they are no longer needed.

## On demand backups

We recommend taking backups of your cloud server before making changes to crucial systems or services. This way you will have the option to revert possible unwanted results if needed. The simplest way of taking backups of your storage disks is to use the on demand option to take an instant backup.

Taking a manual backup of your server is easy and happens in a flash.

- First, select the storage devices you wish to back up.
- Then click the *Take backup now* button below.

![On demand backups view](img/image-3.png)

## Restoring from a backup

Once you’ve backed up any storage device, it can be seen on the backup’s *History* list. A backup will show the time and date of when it was made, the name of the backup, and what storage device it is from.

![Backups history view](img/image-4.png)

Backups are essential to data safety, however, they would be of little use without an easy way to restore their content. Fortunately, a storage device can be restored from a backup with a couple of steps in the server settings under the Backups tab. Read our guide for [restoring backups](/docs/guides/restoring-backups.md) which includes methods of complete storage restoration, or bringing back individual files on both Linux and Windows Cloud Servers.

## Backup storage pricing

Simple Backup is priced affordably according to the data retention duration and the monthly cloud server plan price it is safeguarding.

**Day plan** with 1 daily backup every 24 hours, included in the plan for free

**Week plan** with 7 daily backups a week, +20% of your cloud server plan price

**Month plan** with 4 weekly backups retained for a month + 7 daily backups, +40% of your monthly plan price

**Year plan** with 12 monthly backups for a year + 7 daily and 4 weekly backups, +60% of your monthly plan price

The pricing for on-demand and flexible backups is calculated similarly to other storage devices. Each backup is a carbon copy of the storage it was taken from, including the size, and priced accordingly per GB of storage per month. We recommend scheduling backups either with Simple or Flexible backups for the best safety of your data.

Additional storage outside any plan is charged at standard rates.

You can find the [full details on our pricing page](https://upcloud.com/pricing/).
