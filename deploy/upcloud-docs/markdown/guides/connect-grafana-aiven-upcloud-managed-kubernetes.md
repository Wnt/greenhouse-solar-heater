# How to connect Grafana on Aiven with UpCloud Managed Kubernetes

Grafana and Kubernetes are the most popular open-source tools for monitoring and managing containerized applications. They are powerful and versatile tools that can help you improve your applications’ performance and reliability.

## Grafana

Grafana is an open-source analytics and monitoring platform connecting various data sources. It enables users to create dynamic, informative dashboards with charts, graphs, and alerts for real-time data visualization and monitoring. Grafana is widely used for IT operations, application performance monitoring, and IoT applications. It is known for its flexibility and ease of use, making it a go-to tool for developers, DevOps teams, and system administrators.

## Kubernetes

Kubernetes is an open-source platform designed to automate deploying, scaling, and operating application containers. It simplifies container management across clusters of hosts, providing features such as self-healing, automatic rollouts and rollbacks, and service discovery. Kubernetes supports a wide range of container tools and integrates with various cloud services, making it a cornerstone for cloud-native development and a vital tool for DevOps practices.

## Why you should use Grafana and Kubernetes together

Grafana and Kubernetes are a powerful combination that can help you monitor and manage your containerized applications more effectively. Here are a few reasons why you should consider using them.

- **Improved visibility:** Grafana’s visualization engine makes it easy to create informative and beautiful dashboards that help you visualize your applications’ performance.
- **Centralized monitoring:** Grafana can connect to a wide range of data sources, including Kubernetes so that you can monitor all of your applications from a single dashboard.
- **Automated alerting:** Grafana’s built-in alerting system can notify you when certain conditions are met so you can quickly identify and resolve any issues.
- **Scalability and reliability:** Kubernetes is designed to be scalable and reliable, so you can be confident that your applications will be up and running even under heavy load.

If you are looking for a robust and reliable way to monitor and manage your containerized applications, then Grafana and Kubernetes are the perfect solutions for you.

This guide will show you how to set up these to efficiently use services from UpCloud and Aiven, our database partner.

### 1. Deploy Managed Kubernetes cluster

To follow this guide, you need to have a Kubernetes cluster to have something to monitor. You can find further instructions in our [Managed Kubernetes guide](/docs/guides/get-started-managed-kubernetes.md) to get started if you don’t already have a cluster up and running. When creating a new Managed Kubernetes cluster, make note to enable the following:

- Create and attach a new SDN Private Network
- Allow API access from your computer IP/network

Once your Kubernetes cluster is ready, we’ll set up a Prometheus stack with Kube State metrics and Node Exporter.

To make things easier, install Helm on your computer to help you manage Kubernetes applications. It can be found in many package managers or downloaded as a binary from its [GitHub repository](https://github.com/helm/helm/releases).

When you’ve installed Helm itself, add the Prometheus chart repository.

```
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
```

Next, prepare a YAML configuration file named “values.yaml” and define your cluster’s SDN network UUID by replacing the two “NETWORK\_UUID\_HERE” occurrences.

```
grafana:
    enabled: false
prometheus:
    service:
        type: LoadBalancer
        annotations:
            service.beta.kubernetes.io/upcloud-load-balancer-config: |
                {
                    "frontends": [
                        {
                            "name": "http-web",
                            "port": 9090,
                            "mode": "http",
                            "networks": [
                                {
                                    "name": "private-IPv4",
                                    "type": "private",
                                    "family": "IPv4",
                                    "uuid": "NETWORK_UUID_HERE"
                                }
                            ]
                        },
                        {
                            "name": "reloader-web",
                            "port": 8080,
                            "mode": "http",
                            "networks": [
                                {
                                    "name": "private-IPv4",
                                    "type": "private",
                                    "family": "IPv4",
                                    "uuid": "NETWORK_UUID_HERE"
                                }
                            ]
                        }
                    ]
                }
```

Then, continue with installing the Helm chart.

```
helm install --values values.yaml prometheus prometheus-community/kube-prometheus-stack
```

```
kubectl get service prometheus-kube-prometheus-prometheus -w
```

Wait until Prometheus has an EXTERNAL-IP ready. The command will print an external LB hostname which looks like “lb-0aab4d6cd568421985d2f38c80b9d085-1.upcloudlb.com”

We will use the load balancer’s private endpoint as a data source in Grafana later. In the hostname, replace “-1” with “-2” so it looks like “lb-0aab4d6cd568421985d2f38c80b9d085-2.upcloudlb.com.” This endpoint is not accessible from the Internet.

### 2. Connect Aiven and UpCloud projects using VPC

Navigate to [Aiven.io](https://aiven.io/) to log in or register.

Once you reach your Aiven console, go to the VPCs section and click the Create VPC button.

![](img/image.png)

Select UpCloud as your Cloud provider, then choose your region and IP range. Note that the IP range on Aiven must not conflict with the private IP range attached to your Managed Kubernetes cluster.

![](img/image-1.png)

Then, wait a moment while the VPC is being created.

![](img/image-2.png)

Next, click the VPC connection and add the network ID of your Managed Kubernetes cluster from your UpCloud Control Panel.

![](img/image-3.png)

Congrats! You have finished setting up your VPC on Aiven and can continue using your [UpCloud Control Panel](https://hub.upcloud.com/) to complete the next part of this guide.

Head over to your UpCloud Control Panel and proceed with the following steps.

First, create a new Peering under the Network section by clicking Create Network Peering.

Copy the network ID from the Aiven console to your clipboard.

![](img/image-4.png)

Give your new peering connection a name and select the Private Network attached to your Managed Kubernetes cluster, as shown below.

Then paste the Aiven network ID in the Target peer field and click Create.

![](img/image-5.png)

You should now have the peering activated.

![](img/image-6.png)

### 3. Create your Grafana instance

Now that the peering part is done, you can continue creating a Grafana instance at Aiven.

Head over to your Aiven dashboard and create the Grafana service.

Select UpCloud as your cloud provider and the location your Managed Kubernetes is located in, as shown in the picture below, then click Create service.

![](img/image-7.png)

Then, wait a moment for the service to start. Once the Grafana service status shows Running, click the Service URI to head to your dashboard and log in with the username and password provided in the service details.

### 4. Prepare dataflows

Next, you will prepare your Grafana dashboard by importing the relevant modules.

1. Access Grafana and create a Prometheus data source
2. Configure internal Load Balancing address as the data source address, exposing Prometheus from Managed Kubernetes
3. Import a Kubernetes API server dashboard from Grafana and verify it works
4. Import a Node exporter dashboard from Grafana to access worker node metrics

Add data sources to your Grafana, start clicking connections

![](img/image-8.png)

Search and add Prometheus by first selecting Prometheus and then clicking the Create a Prometheus data source button in the top right corner.

![](img/image-9.png)

Add the Prometheus service URL from your UpCloud Load Balancer as explained in section 1.

![](img/image-10.png)

Modify dashboard details if needed.

![](img/image-11.png)

Then, import the dashboard.

![](img/image-12.png)

### 5. Create dashboards to monitor and visibility

And now you only need to import the dashboards

Start importing dashboards using port 12006 Kubernetes API server.

![](img/image-13.png)

Import dashboard for Kubernetes API server

![](img/image-14.png)

Then, start importing dashboards with port 1860 Node Exporter Full.

![](img/image-15.png)

Import dashboard for Node exporter.

![](img/image-16.png)

That’s it! You should now have the following two monitoring views for your Grafana service.

![](img/image-17.png)

![](img/image-18.png)

It seems the CPU is quite busy. You could configure alerts to notify you whenever CPU usage goes up.
