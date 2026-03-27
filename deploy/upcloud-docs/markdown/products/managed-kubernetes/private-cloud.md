# Managed Kubernetes on Private Cloud

UpCloud's Managed Kubernetes service supports running cluster worker nodes on our [Private Cloud offering](/docs/products/private-cloud.md), combining a fully managed service with the added advantages of a private cloud environment.

## Overview

Dedicated resources on Private Cloud ensure a consistent Kubernetes performance, free from the "noisy neighbor" effect sometimes seen in public clouds.
This enables use cases for running demanding applications with confidence, leveraging the power of Kubernetes on dedicated hardware. Running Kubernetes in a Private Cloud is particularly convenient for
regulated industries or organisations dealing with sensitive data.

## Deploying a cluster in Private Cloud

The process is the same as deploying a cluster into the public cloud. Just select your Private Cloud zone upon cluster creation and you are good to go!

When a cluster is deployed into a Private Cloud zone (for example, `de-exa1`), only the Kubernetes data plane is deployed into the private cloud zone.
Through this customers can utilise their Private Cloud capabilities in full for running their workloads on Kubernetes. The Kubernetes control plane is deployed
to the parent zone (for example `de-fra1`, or Frankfurt) as a managed service.

## Limitations and requirements

- Clusters deployed to a Private Cloud zone are limited to running the cluster data plane within the same Private Cloud zone. At this time, it is not possible to run Public Cloud worker nodes in the same cluster.
- See [networking requirements](/docs/products/managed-kubernetes/data-plane#network-connectivity.md) for all UpCloud Managed Kubernetes clusters.
