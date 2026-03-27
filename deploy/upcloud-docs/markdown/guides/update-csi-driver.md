# Update CSI driver in UpCloud Kubernetes Service

The CSI driver consists of two services running in the `kube-system` namespace:

- node service `daemonset/csi-upcloud-node`
- controller service `statefulset/csi-upcloud-controller`

Although it's recommended to keep both services running the same driver version, it's not strictly required.

The CSI driver can be updated by modifying the driver's image tag. Both services support rolling updates, which means you can update them without downtime.

## Check the current driver version

First, check which version of the CSI driver is currently running in your cluster. You'll need this information for potential rollback scenarios.

Check the controller service version:

```
$ kubectl -n kube-system get statefulset/csi-upcloud-controller -o jsonpath='{range .spec.template.spec.containers[*]}{.image}{"\n"}{end}'
```

The output will show several container images. Look for the `ghcr.io/upcloudltd/upcloud-csi` image:

```
k8s.gcr.io/sig-storage/csi-provisioner:vX.Y.Z
k8s.gcr.io/sig-storage/csi-attacher:vX.Y.Z
k8s.gcr.io/sig-storage/csi-resizer:vX.Y.Z
k8s.gcr.io/sig-storage/csi-snapshotter:vX.Y.Z
ghcr.io/upcloudltd/upcloud-csi:v1.0.0
```

From the output above we can see that we have controller service v1.0.0

Next, check the node service version:

```
$ kubectl -n kube-system get daemonset/csi-upcloud-node -o jsonpath='{range .spec.template.spec.containers[*]}{.image}{"\n"}{end}'
```

The output should look like this:

```
k8s.gcr.io/sig-storage/csi-node-driver-registrar:vX.Y.Z
ghcr.io/upcloudltd/upcloud-csi:v1.0.0
```

Driver version v1.0.0 is currently running.

Before updating, you should review the CSI [changelog](https://github.com/UpCloudLtd/upcloud-csi/blob/main/CHANGELOG.md) to see if there are any breaking changes between versions, and check for specific upgrade instructions for your version jump.

## Update the CSI driver

Once you've reviewed the changes and are ready to proceed, update both the controller and node services to the new version. In this example, we'll update from v1.0.0 to v1.1.0.

```
$ kubectl -n kube-system set image statefulset/csi-upcloud-controller csi-upcloud-plugin=ghcr.io/upcloudltd/upcloud-csi:v1.1.0
statefulset.apps/csi-upcloud-controller image updated
```

```
$ kubectl -n kube-system set image daemonset/csi-upcloud-node csi-upcloud-plugin=ghcr.io/upcloudltd/upcloud-csi:v1.1.0
daemonset.apps/csi-upcloud-node image updated
```

These commands will trigger a rolling update for both services. Monitor the rollout progress to ensure all pods are updated successfully.

```
$ kubectl -n kube-system get pod -l app=csi-upcloud-node

NAME                     READY   STATUS    RESTARTS   AGE
csi-upcloud-node-d6zlf   2/2     Running   0          31s
csi-upcloud-node-k54vw   2/2     Running   0          27s
csi-upcloud-node-mj26w   2/2     Running   0          29s
```

```
$ kubectl -n kube-system get pod -l app=csi-upcloud-controller

NAME                       READY   STATUS    RESTARTS   AGE
csi-upcloud-controller-0   5/5     Running   0          54s
```

Use the version check command from above to confirm that all pods are using the new v1.1.0 image.
