# How to use File Storage (NFS) with Managed Kubernetes

Managed Kubernetes supports Read-Write-Once (RWO) persistent volumes out of the box via the UpCloud CSI driver. For workloads that need multiple pods to share the same storage simultaneously, [File Storage](/docs/products/file-storage.md) provides NFS shares that Kubernetes can mount as RWX persistent volumes.

Before starting, make sure you have created a File Storage instance and configured a share - if not, follow the [File Storage getting started guide](/docs/guides/file-sharing-over-nfs-on-ubuntu.md) first. Your Managed Kubernetes cluster and File Storage instance must also be connected to the same SDN Private Network, with a read and write access rule covering the worker nodes' subnet.

If you prefer to keep everything inside the cluster without a separate managed service, see the [OpenEBS NFS Provisioner guide](/docs/guides/uks-with-openebs-nfs-provisioner.md) instead.

## Verifying connectivity

Before creating any Kubernetes resources, confirm that your worker nodes can reach the share. If you have SSH access to a worker node, a quick test mount is the most direct way to check:

```
sudo mkdir -p /mnt/nfs-test
sudo mount -t nfs -o vers=4.1 FILE_STORAGE_IP:/your/share/path /mnt/nfs-test
df -h /mnt/nfs-test
sudo umount /mnt/nfs-test
```

If you see the share capacity in the `df` output, connectivity and access rules are working correctly.

If you do not have SSH access, skip ahead - a failed mount will surface clearly in the pod events when you reach the deployment step.

> **Note:** If you check `systemctl status nfs-common` on a worker node and see the service listed as `masked`, this is normal on modern Debian systems. The `nfs-common` package is installed and `mount.nfs` is available - Kubernetes does not use the service directly.

## Creating the PersistentVolume

Save the following to `pv-file-storage.yaml`:

```
apiVersion: v1
kind: PersistentVolume
metadata:
  name: file-storage-pv
spec:
  capacity:
    storage: 250Gi # size of your File Storage
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""      # Prevents dynamic provisioning
  nfs:
    server: FILE_STORAGE_IP
    path: /your/share/path
  mountOptions:
    - vers=4.1
    - nconnect=8
    - rsize=1048576
    - wsize=1048576
    - noatime
    - hard
```

Make sure to set storage to match the size of your File Storage share.

```
kubectl apply -f pv-file-storage.yaml
kubectl get pv file-storage-pv
```

```
NAME              CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS      CLAIM   STORAGECLASS   AGE
file-storage-pv   250Gi      RWX            Retain           Available                          5s
```

## Creating the PersistentVolumeClaim

Save the following to `pvc-file-storage.yaml`:

```
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: file-storage-pvc
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 250Gi # size of your File Storage
  volumeName: file-storage-pv
  storageClassName: ""
```

The storage value must match the PV exactly.

```
kubectl apply -f pvc-file-storage.yaml
kubectl get pvc file-storage-pvc
```

```
NAME               STATUS   VOLUME            CAPACITY   ACCESS MODES   STORAGECLASS   AGE
file-storage-pvc   Bound    file-storage-pv   250Gi      RWX                           8s
```

If the PVC shows `Pending` rather than `Bound`, see the troubleshooting section below.

## Verifying shared access across nodes

Deploy two pods that share the same PVC - a writer and a reader - with anti-affinity to ensure they land on separate nodes.

Save the following to `test-deployment.yaml`:

```
apiVersion: v1
kind: Pod
metadata:
  name: nfs-writer
  labels:
    app: nfs-test
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: nfs-test
          topologyKey: kubernetes.io/hostname
  containers:
    - name: writer
      image: busybox
      command:
        - sh
        - -c
        - |
          while true; do
            echo "hello from nfs-writer at $(date)" > /mnt/shared/writer.txt
            sleep 3
          done
      volumeMounts:
        - mountPath: /mnt/shared
          name: nfs-volume
  volumes:
    - name: nfs-volume
      persistentVolumeClaim:
        claimName: file-storage-pvc
---
apiVersion: v1
kind: Pod
metadata:
  name: nfs-reader
  labels:
    app: nfs-test
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: nfs-test
          topologyKey: kubernetes.io/hostname
  containers:
    - name: reader
      image: busybox
      command:
        - sh
        - -c
        - sleep 3600
      volumeMounts:
        - mountPath: /mnt/shared
          name: nfs-volume
  volumes:
    - name: nfs-volume
      persistentVolumeClaim:
        claimName: file-storage-pvc
```

> **Note:** `requiredDuringSchedulingIgnoredDuringExecution` requires at least two nodes. Remove the `affinity` block if your cluster has only one node.

```
kubectl apply -f test-deployment.yaml
kubectl get pods -o wide
```

```
NAME         READY   STATUS    RESTARTS   AGE    IP              NODE
nfs-reader   1/1     Running   0          104s   192.168.2.181   default-png9c-rbktt
nfs-writer   1/1     Running   0          105s   192.168.3.26    af-node-group-5kqqp-2n6cx
```

Read the file from the reader pod to confirm it can see what the writer has written:

```
kubectl exec nfs-reader -- cat /mnt/shared/writer.txt
```

```
hello from nfs-writer at Sun Feb 22 08:37:48 UTC 2026
```

## Cleaning up

```
kubectl delete pod nfs-writer nfs-reader
kubectl delete pvc file-storage-pvc
kubectl delete pv file-storage-pv
```

With `persistentVolumeReclaimPolicy: Retain`, deleting the PV and PVC does not remove data from the File Storage share. Any files written during the test will remain on the share until removed directly.

## Troubleshooting

**PVC stuck in Pending**

Check that `storageClassName`, `accessModes`, and `volumeName` in the PVC match the PV exactly. Run `kubectl describe pvc file-storage-pvc` for details on why the binding failed.

**Pod stuck in ContainerCreating**

Run `kubectl describe pod <pod-name>` and check the Events section. A `mount.nfs: Connection timed out` error means the worker node cannot reach the File Storage IP, or the share ACL does not cover the node's IP address.

**Permission denied when writing to the share**

The share root is owned by `root` by default. Pods that do not run as root will need to write to a subdirectory with appropriate ownership, or use a `securityContext` to match the share's permissions.
