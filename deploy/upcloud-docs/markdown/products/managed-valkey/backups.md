# Managed Valkey Backups

Each Managed Database plan includes automated backups. Backups are taken every 12 hours and are stored according to the following schedule:

- up to 24 hours for 1-node plans
- up to 36 hours for 2-node plans
- up to 84 hours for 3-node plans

These backups can be used to restore your managed service. Backups are taken using RDB snapshots and might cause minor performance degradation. If the backups are not required, you can disable them completely by setting `"valkey_persistence"` to `"off"` from the `"Properties"` tab via the [UpCloud Control Panel](https://hub.upcloud.com/) or [API](https://developers.upcloud.com/).

\* Valkey and the Valkey logo are trademarks of LF Projects, LLC. Any rights therein are reserved to LF Projects, LLC. Any use by UpCloud is for referential purposes only and does not indicate any sponsorship, endorsement or affiliation between Valkey and UpCloud.
