# Getting Started with GPU Workloads in Managed Kubernetes

GPU node groups in UpCloud Managed Kubernetes come with GPU drivers pre-installed and the GPU is exposed to the container runtime.

However, the NVIDIA device plugin is not pre-installed. You must install it so that Kubernetes can use `nvidia.com/gpu` resource limits.

## Prerequisites

- An UpCloud Managed Kubernetes cluster with a GPU node group added
- `kubectl` and `helm` configured in your local terminal

## Install NVIDIA Device Plugin

Run the following commands to install the NVIDIA device plugin:

```
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia && helm repo update
helm install nvidia-device-plugin nvidia/nvidia-device-plugin -n kube-system
```

See [nvidia-device-plugin documentation](https://github.com/NVIDIA/k8s-device-plugin#deployment-via-helm) for additional configuration details.

If your cluster also has node groups without GPUs, you can set the device plugin DaemonSet
to use a node selector:

```
helm install nvidia-device-plugin nvidia/nvidia-device-plugin -n kube-system \
  --set nodeSelector.gpu='NVIDIA-L40S'
```

Device plugin is then only scheduled to nodes with a matching label `gpu: NVIDIA-L40S`.

## Verify the plugin is running

Check that the DaemonSet is scheduled on your GPU nodes and ready:

```
kubectl -n kube-system get ds nvidia-device-plugin
```xml

You should see `DESIRED` and `AVAILABLE` match the number of GPU nodes in your cluster.

Next, confirm the `nvidia.com/gpu` resource shows up on those nodes:

```bash
# Get nodes
kubectl get nodes

# Replace <GPU_NODE_NAME> with one of your GPU node names
kubectl describe node <GPU-NODE-NAME>
```

You should see `Capacity` and `Allocatable` list `nvidia.com/gpu: <count>`.

## Run a quick GPU smoke test

Create a one-off `Job` that requests a GPU and prints hardware and driver details:

```
apiVersion: batch/v1
kind: Job
metadata:
  name: gpu-smoke-test
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: cuda
          image: nvidia/cuda:12.4.1-base-ubuntu22.04
          command: ["bash", "-lc", "nvidia-smi"]
          resources:
            limits:
              nvidia.com/gpu: 1
```bash

Apply and view output:

```bash
kubectl apply -f gpu-smoke-test.yaml
kubectl wait --for=condition=complete job/gpu-smoke-test
kubectl logs job/gpu-smoke-test
```

If everything is set up, you’ll see the GPU model and driver info.

Once the plugin is installed and verified, your GPU nodes are ready to schedule real GPU workloads.
