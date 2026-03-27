# How to configure network peering

Network peering is a powerful feature that allows you to connect multiple Virtual Private Clouds (VPCs) and create a unified network environment. With UpCloud, you can enjoy the following benefits of VPC peering:

- Combine multiple UpCloud VPCs into a larger private network for expanded reach.
- Establish secure, private links between your UpCloud resources and those on other cloud platforms like Aiven.io.
- Enhance security by ensuring that traffic between peered VPCs never touches the public internet.
- Experience low-latency, high-bandwidth connections, which are ideal for data transfers and collaboration between different clouds.

Follow the steps below to enable network peering on UpCloud:

1. Log in to your UpCloud account and navigate to the hub.upcloud.com dashboard.
2. From the left sidebar, click on "Networks" and then select "Peering".

![Step1](media/image-1.png)

3. On the Peering page, click on the "Create network peering" button.
4. In the "Create network peering" form, enter the following details:

**Peering name**: Enter a descriptive name for your peering connection.

**Source peer**: Select one of your existing networks as the source peer.

**Target peer UUID**: Provide the UUID of the target peer network you want to connect to.

![Step2](media/image-2.png)

5. Click on the "Create" button to initiate the peering process.
6. After creating the peering request, your peering will be in the "Pending peer" status. This means that the peering now needs to be created from the other side, i.e., from the target network to your source network.

![Step3](media/image-3.png)

7. Once the peering is created on both sides, it becomes active, and traffic can be shared between the peered networks.

To delete a peering connection, you first need to disable it. Ensure that you disable the peering before attempting to delete it.
