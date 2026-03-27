# Migrating workloads from one Kubernetes cluster to another using Velero

This guide provides a step-by-step walkthrough on how to easily migrate Kubernetes workloads using Velero. This process is designed to be non-destructive, allowing you to test your new environment before making the switch.

**Important Note:** This migration process is necessary to upgrade from [UKS](https://upcloud.com/products/managed-kubernetes/) clusters running Kubernetes versions 1.29 and below. For clusters running Kubernetes 1.30+, UKS supports in-place upgrades, so *no migrations are necessary* in order to upgrade Kubernetes versions.

⏱️ Migration at a glance

- **Difficulty:** Medium (requires CLI familiarity)
- **Estimated Time:** 30–60 minutes (excluding data transfer time)
- **Risk Level:** Low (Side-by-side migration; Cluster A remains untouched)

## Prerequisites

- The existing cluster you mean to migrate from Kubernetes version 1.29 or below.
- A fresh new cluster (the one you want to migrate to) running Kubernetes version 1.30+
- An Object Storage service.
- The [Velero CLI](https://velero.io/docs/main/basic-install/#install-the-cli)

## Some notes before migrating

- **Version Compatibility:** Velero supports restoring to a higher Kubernetes version (e.g., 1.28 to 1.30), but does not support restoring to a lower version.
- **API Deprecations:** Ensure your workloads do not use Kubernetes APIs that were removed in version 1.30. Check the [Kubernetes Removals and Deprecations](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) guide.
- **Cluster Names:** Going forth, the initial (legacy) cluster will be referred to as “Cluster A” and the new (v1.30+) cluster, “Cluster B”.

## Set up an Object Storage service and Bucket

Using Velero, we will configure backups of Cluster A's data to be stored in [Managed Object Storage](https://upcloud.com/products/object-storage/) to store backup data from Cluster A. This backup will then be used to restore the data to Cluster B.

- In the [UpCloud Control Panel](https://hub.upcloud.com/), head to the Object Storage page and hit “Create Object Storage”. Select your preferred region and provide a name. If you need a private network, attach it now. Then, click Create.
- Next, create a bucket named `velero`.
- Then go to the "Users" tab. Click "+ Add User" and provide a descriptive name for this user (e.g., `velero_user`). Next, click the "+ Policy" button and select “ECSS3FullAccess” from the available policies and click “Attach”. This grants the user full access to your S3-compatible storage. Additionally, you can create a custom policy that allows the user to access the `velero` bucket. Finally, click the "+ Access Key" button. A new Access Key and Secret Key will be generated. Important: Copy both keys immediately and store them securely. You will not be able to retrieve the Secret Key again.

## Step-by-step Migration

Create a configuration file for Velero named `velero.conf`. Replace the placeholders with your actual keys:

```
[default]
AWS_ACCESS_KEY_ID=<access_key>
AWS_SECRET_ACCESS_KEY=<secret_key>
```

- To connect our Managed Kubernetes cluster to our Managed Object Storage bucket, we will use Velero’s AWS S3 provider so we have to install Velero on both clusters A and B. When configuring Velero, replace `<region>` with the lowercase region of your Managed Object Storage instance and `<hostname>` with the S3 endpoint found under "Public access" in your Object Storage instance settings. Replace `<path_to_cluster_A_kubeconfig>` with the kubeconfig file pointing to cluster A.

```
export KUBECONFIG=<path_to_cluster_A_kubeconfig>
velero install --provider aws \
    --features=EnableCSI \
    --plugins velero/velero-plugin-for-aws:v1.9.0 \
    --bucket velero --secret-file ./velero.conf \
    --backup-location-config region=<region>,s3ForcePathStyle="true",s3Url=<hostname> \
    --use-volume-snapshots=true
```

- Next, we will install Velero on cluster B so switch your context to cluster B using the following command, replacing `<path_to_cluster_B_kubeconfig>` with the path where the `kubeconfig` of your cluster B is stored.

```
export KUBECONFIG=<path_to_cluster_B_kubeconfig>
```

- Now that your `kubectl` context is set to Cluster B, install Velero using the same command from earlier (again, replace placeholders):

```
velero install --provider aws \
    --features=EnableCSI \
    --plugins velero/velero-plugin-for-aws:v1.9.0 \
    --bucket velero --secret-file ./velero.conf \
    --backup-location-config region=<region>,s3ForcePathStyle="true",s3Url=<hostname> \
    --use-volume-snapshots=true
```

- After installing Velero in Cluster B, we will create a restore resource modifier for Velero to leverage while doing the restore. The purpose of this modifier is to remove any attached load balancer metadata from services, so Managed Kubernetes will re-create the load balancers for Cluster B. By default, we are applying the modifier to every service, but feel free to change the `resourceNameRegex` according to your needs. Continuing with this cluster,create a file named `service-modifier.yaml` with the following contents:

```
version: v1
resourceModifierRules:
  - conditions:
      groupResource: services
      resourceNameRegex: "*"
    patches:
      - operation: remove
        path: "/metadata/annotations/service.beta.kubernetes.io/upcloud-load-balancer-id"
      - operation: remove
        path: "/metadata/annotations/service.beta.kubernetes.io/upcloud-load-balancer-name"
      - operation: remove
        path: "/status/loadBalancer"
```

- We need to make the service modifier configuration available to Velero in Cluster B, so create a ConfigMap named `service-modifier` in the `velero` namespace using this command:

```
kubectl create cm service-modifier --from-file service-modifier.yaml -n velero
```

- Now, switch your kubectl context to Cluster A and create the backup of all resources (`--include-resources='*'`):

```
export KUBECONFIG=path/to/cluster-A-kubeconfig
velero backup create backup-1 --include-resources='*' --wait
```

- Run `velero get backups` to verify that the backup is listed. If it's not visible, check the Velero logs in Cluster A for errors. You can use `kubectl logs -n velero <velero-pod-name>` to view the logs.
- Once the backup creation process is finished, switch your kubectl context to Cluster B and verify that the backup you created in Cluster A is visible:

```
export KUBECONFIG=path/to/cluster-B-kubeconfig
velero backup describe backup-1
```

- If the backup isn't immediately visible, wait a short while and try again. Velero in Cluster B needs to synchronize with the object storage bucket, so it might take a few minutes for the backup to appear.
- When the backup appears in Cluster B, you're ready to restore it using the following command:

```
velero restore create --from-backup backup-1 --resource-modifier-configmap service-modifier
```

- Immediately after running this command, you can monitor the restore's progress with `velero restore get` and `velero restore describe <restore-name>` (replacing `<restore-name>` with the name from `velero restore get`). Be aware that the restore resource is automatically deleted upon completion, so it will no longer be visible via these commands.
- After the restore process completes, it's crucial to verify that the restore was successful. Check the restored applications and data in Cluster B to ensure they are functioning as expected. This might include checking pod status (`kubectl get pods`), application logs, and database integrity.

Your Managed Kubernetes cluster migration using Velero is complete! If you no longer require the Managed Object Storage, you can delete it. Important: Deleting the Managed Object Storage will permanently erase all data stored within it. Ensure you have backups of any data you need before proceeding with deletion.
