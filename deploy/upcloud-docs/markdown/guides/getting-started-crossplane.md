# Getting started with UpCloud Crossplane provider

In this getting started guide you will learn how to:

- Install Crossplane related tooling into your Kubernetes cluster
- Install UpCloud Crossplane Provider and required provider configuration
- Create an SDN network and a Cloud Server with Crossplane

## Prerequisites

First, you will need to install Crossplane tooling on your local machine. [Follow the instructions](https://docs.upbound.io/reference/cli/) on their documentation.

Next, create a Kubernetes cluster - any will do.

- To create an UpCloud Kubernetes cluster, follow the guide available [here](/docs/guides/get-started-managed-kubernetes.md).
- You can also use [kind](https://kind.sigs.k8s.io/docs/user/quick-start/) to create a local development cluster with `kind create cluster -n crossplane-test`.

Prepare the `kubeconfig` for accessing your cluster. Ensure you have the right configuration and the right context in use by running:

```
kubectl config get-contexts
```

Once you are ready, run `up uxp install`. This command installs the latest Upbound Universal Crossplane (UXP) management pods and
custom resource definitions (CRD) into your cluster through a Helm chart.

## Installing the provider

Install the Crossplane UpCloud provider. The simplest way to do that is to just apply the following YAML manifest with `kubectl`:

```
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-upcloud
spec:
  package: xpkg.upbound.io/upcloud/provider-upcloud:v0.1.0
```

Next, create a `Secret` with your UpCloud API credentials and a `ProviderConfig` that will use them to provision your infra. Add your credentials to the following manifest and apply it with `kubectl`:

```
apiVersion: v1
kind: Secret
metadata:
  name: example-provider-creds
  namespace: default
type: Opaque
stringData:
  credentials: |
    {
      "token": "ucat_TOKEN"
    }
---
apiVersion: provider.upcloud.com/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      name: example-provider-creds
      namespace: default
      key: credentials
```

See examples in the [UpCloud crossplane provider repository](https://github.com/UpCloudLtd/crossplane-provider-upcloud) for examples on how to set up namespace-scoped provider configurations.

## Create a network

First, lets create an SDN network.

```
apiVersion: network.upcloud.com/v1alpha1
kind: Network
metadata:
  name: example
spec:
  forProvider:
    ipNetwork:
    - address: 10.100.0.0/24
      dhcp: true
      dhcpDefaultRoute: false
      family: IPv4
    name: crossplane-example-net
    zone: de-fra1
```

Verify the network status:

```
$ kubectl get network.network.upcloud.com/example
NAME      READY   SYNCED   EXTERNAL-NAME                          AGE
example   True    True     abbaacdc-9463-4327-1337-14d5566ad2d1   5s
```

## Create a server

Finally, create a Cloud Server to the network we created in the previous step.

```
apiVersion: server.upcloud.com/v1alpha1
kind: Server
metadata:
  name: example
spec:
  forProvider:
    hostname: crossplane-example-server
    title: crossplane-example-server
    labels:
      env: dev
      production: "false"
    login:
    - user: example
    networkInterface:
    - type: public
    - type: private
      networkRef:
        name: example
    plan: 1xCPU-1GB
    metadata: true
    template:
    - size: 25
      storage: Ubuntu Server 24.04 LTS (Noble Numbat)
    zone: de-fra1
```

See server status and wait until the resource has been created:

```
$ kubectl get server.server.upcloud.com/example -w
NAME      READY   SYNCED   EXTERNAL-NAME   AGE
example   False   True                    36s
...
example   True    True     00eeface-b00c-4587-b857-cafe9f1ed5a6   55s
```

You can list server details, such as IP addresses, through `kubectl describe server.server.upcloud.com/example`.

## Next steps

For a complete list of examples, check [the examples in the GitHub repository](https://github.com/UpCloudLtd/provider-upcloud/tree/main/examples/resources) to see what other Managed Resources you can use and how.

Have fun!
