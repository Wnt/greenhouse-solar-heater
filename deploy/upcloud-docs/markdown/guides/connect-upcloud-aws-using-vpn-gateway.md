# How to connect UpCloud to AWS using VPN Gateway

The [VPN Gateway](/docs/products/vpn-gateway.md) allows you to connect to external networks securely through a VPN endpoint. It operates with our SDN Router, which can connect with one or multiple SDN Private Networks. All Cloud Servers connected to one of these SDN Private Networks can access the external networks via the Gateway.

In this guide, we will demonstrate how to set up a multi-cloud connection between UpCloud VPN Gateway and AWS VPN endpoint by completing the following steps:

1. Create an UpCloud SDN Private Network
2. Create an UpCloud SDN Router and connect to the private network
3. Create an UpCloud VPN Gateway and connect it to the Router
4. Create a new AWS VPC
5. Create a new AWS Customer Gateway
6. Create a new AWS Virtual Private Gateway
7. Create a AWS Site-to-Site VPN Connection
8. Set up IPs and PSKs on the UpCloud VPN Gateway
9. Launch new servers on both AWS and UpCloud
10. Test the multi-cloud VPN connection

Please note that the VPN Gateway operates on a route-based site-to-site connection. Policy-based VPN is not currently supported.

In addition to actual VPN and routing setup, this tutorial includes steps for VPC and security group creation on AWS and creating an EC2 instance and a Cloud Server on the UpCloud side for testing.

Note that a suitable VPC must exist on your AWS account before setting up Site-to-Site VPN can start.

## Setting up VPN Gateway on UpCloud

To start, log in to your UpCloud Control Panel or sign up if you haven’t already.

### Create a new UpCloud Private SDN network

Create a new SDN Private Network by navigating to the following section:

Network -> Private networks -> "Create SDN network"

Configure your network by adding the following details:

- Set a name: e.g. aws-vpn-net
- Define the IP network: 192.168.100.0/24
- Click to show DHCP routing options, then add DHCP route: 192.168.200.0/24

Lastly, click the "Create SDN network" button to finish.

![upcloud-private-network-create](img/1-upcloud-private-network-create.png)

### Create a new UpCloud router

Next, you will need to create a new SDN Router in the Network section under Routers:

Network -> Routers -> "Create SDN Router"

Name your router so that you can recognise it later.

- Name the router: e.g. aws-vpn-router
- Go to the router details and click the “Attach SDN private network” button
- Select the location of your SDN network and choose it from the Networks list: aws-vpn-net
- Disable "Add DHCP routes", then enable “DHCP” and “Add default route by DHCP"

When ready, click the “Attach network” button.

![upcloud-router-attach-private-network](img/3-upcloud-router-attach-private-network.png)

### Create a new UpCloud VPN Gateway

You are now ready to create your VPN Gateway. Head over to the VPN Gateways section and click the “Create VPN Gateway” button:

Network -> VPN Gateways -> "Create VPN Gateway"

- Choose your SDN router: aws-vpn-router
- Select the service plan: Production
- Next, give your gateway an appropriate name or use the default

Then click the "Create VPN Gateway" button to confirm.

![upcloud-vpn-gateway-create](img/4-upcloud-vpn-gateway-create.png)

Note that the initial configuration may take a while.

The important information needed from this point is the public IP address in the VPN gateway overview, which we will supply to the AWS VPC customer gateway later.

![upcloud-vpn-gateway-configuring](img/5-upcloud-vpn-gateway-configuring.png)

You can leave the gateway to be created for now and continue with the AWS side.

## Setting up VPN endpoint on AWS

Head over to your AWS customer portal

### Create a new AWS VPC

Now, find the following section and create a new Virtual Private Connection:

- Go to the VPC section under Networking & Content Delivery in the Services menu
- Select Your VPCs and click the “Create VPC” button
- In the configuration view, choose “VPC only”
- Give your network a name: e.g. upcloud-vpn-vpc
- Set the network range: IPv4 CIDR 192.168.200.0/24

Then, click the "Create VPC" button to apply the configuration.

![aws-vpc-create-vpc](img/6-aws-vpc-create-vpc.png)

### Create a new AWS Customer Gateway

Next, create a new gateway by navigating to the following section:

At the VPC dashboard, select Customer Gateways under the Virtual Private Network section. Then click the “Create Customer Gateway” button.

Next, do the following configurations:

- Set a name: upcloud-vpn-customer-gateway
- Copy and paste the public IP address from your UpCloud VPN Gateway overview to the IP address field

Once set, click the "Create Customer Gateway" button.

![aws-customer-gateway-create](img/7-aws-customer-gateway-create.png)

### Create a new AWS Virtual Private Gateway

You can now create the network gateway and attach it to the VPC.

VPN -> Virtual Private Gateways -> “Create virtual private gateway”
Do the following:

- Give your gateway a name: e.g. upcloud-virtual-private-gateway
- Click the "Create virtual private gateway" button

![aws-vpn-gateway-create](img/8-aws-vpn-gateway-create.png)

- Select the new gateway on the virtual private gateway list

Wait until the State shows “Detached”

- Then, choose from the options: Actions -> Attach to VPC
- Select your gateway: upcloud-vpn-vpc
- Click the "Attach to VPC" button

![aws-vpn-gateway-attach-vpc](img/9-aws-vpn-gateway-attach-vpc.png)

### Edit AWS VPC route table propagation

With the network components in place, edit the route table settings to enable propagation.

Virtual private cloud -> Route tables

- Select the route table with your upcloud-vpn-vpc as the VPC
- Choose from the options: Actions -> Edit route propagation

![aws-route-tables-edit-propagation](img/10-aws-route-tables-edit-propagation.png)

- Enable propagation for the VPC

Once done, click the "Save" button to apply the changes.

![aws-route-tables-enable-propagation](img/11-aws-route-tables-enable-propagation.png)

### Create AWS Site-to-Site VPN Connection

Next, we’ll set up the VPN tunnel from the AWS side. Go to the following section and create a new connection:

Virtual private network -> Site-to-Site VPN Connections -> "Create VPN Connection"

Then add the following configurations:

- Name the connection: e.g. upcloud-vpn
- Select your upcloud-virtual-private-gateway as the virtual private gateway
- Select your upcloud-vpn-customer-gateway as the customer gateway ID
- Choose the Routing option: static
- Add routes using static IP prefixes 192.168.100.0/24 and 192.168.200.0/24
- Make sure these appear as blue boxes below the input field
- Set the 192.168.200.0/24 IP range as local IPv4 network CIDR
- Set the 192.168.100.0/24 IP range as remote IPv4 network CIDR

![aws-vpn-connection-create](img/12-aws-vpn-connection-create.png)

- Set a pre-shared key in Tunnel 1 options and copy it for your records
  You can use the following to generate keys on a Linux or macOS command line:
  date | sha256sum | base64 | head -c 64; echo
- Set a pre-shared key in Tunnel 2 options and save it as well

When set, click the "Create VPN connection" button to confirm the settings.

![aws-vpn-connection-configure-tunnels](img/13-aws-vpn-connection-configure-tunnels.png)

## Set up IP addresses and pre-shared keys on the UpCloud VPN Gateway

You should now have your site-to-site VPN ready on the AWS side. Find the necessary information for your connection in the following details:

Virtual private network -> Site-to-Site VPN connections

- Open the VPN ID link for the VPN connection with the name upcloud VPN
- Find the outside IP addresses in the tunnel details

![aws-vpn-connection-status-idle](img/14-aws-vpn-connection-status-idle.png)

Then head over to your UpCloud Control Panel and navigate to the following section:

VPN Gateways -> your VPN gateway -> VPN Connections

Click the "Configure connections" button and then "Add new tunnel”.

- Copy the outside IP address from your Tunnel 1 in AWS view to the Remote IP address
- Set the pre-shared key to use the one added to Tunnel 1 in AWS
- Then click the "Save" button to apply.

![upcloud-vpn-gateway-create-tunnel](img/15-upcloud-vpn-gateway-create-tunnel-1.png)

Repeat the steps to create a second tunnel by clicking the "Add new tunnel" button.

- Copy the outside IP address of Tunnel 2 in AWS view to the Remote IP address
- Set the pre-shared key to use the one added to Tunnel 2 in AWS
- Apply the tunnel settings by clicking the "Save" button

![upcloud-vpn-gateway-create-tunnel](img/16-upcloud-vpn-gateway-create-tunnel-2.png)

- Next, choose 192.168.100.0/24 as a local route, and click the "Add" button
- Set 192.168.200.0/24 as a remote route, then click the "Add" button
- Then, apply the configurations again by clicking the "Save" button

![upcloud-vpn-gateway-routes](img/17-upcloud-vpn-gateway-routes.png)

## Create your test servers on both platforms

The site-to-site VPN should now be configured and ready. However, the tunnels will not be truly established without any traffic passing through them. To test that the connection works, create servers on both platforms or use your existing ones.

### Launch an AWS EC2 instance for testing

Create a new EC2 instance and attach it to the site-to-site network as indicated below:

EC2 -> "Launch Instance"

- Set a suitable name, instance type, key pair
- Edit the Network Settings and select upcloud-vpn-vpc as VPC

Then, click the "Create new subnet" button. This opens in a new browser tab.

- Select upcloud-vpn-vpc as VPC ID
- Name it: e.g. upcloud-vpn-vpc-subnet
- Then enter 192.168.200.0/28 as IPv4 VPC CIDR block

Click the "Create subnet" button.

![aws-ec2-create-subnet](img/18-aws-ec2-create-subnet.png)

- Return to the “Launch an instance | EC2” tab
- Reload “subnets” in the network settings by clicking the circular arrow
- Verify that the upcloud-vpn-vpc-subnet is selected

![aws-ec2-deploy-attach-vpc](img/19-aws-ec2-deploy-attach-vpc.png)

- Disable "Auto-assign public IP"
- Choose "Create security group"
- Click the "Add security group rule"
- Select the rule type "All ICMP - IPv4" and the source type "Anywhere"

When done, click the "Launch instance" button to finish the server creation.

![aws-ec2-add-security-group-rule](img/20-aws-ec2-add-security-group-rule.png)

### Deploy a new Cloud Server on UpCloud

While your EC2 instance is being created, deploy a new server on your UpCloud account as well by going to the following section in your UpCloud Control Panel:

Servers -> "Deploy server"

- Select a suitable plan and a Linux operating system of your choice
- Choose "Attach private network" under Network
- Choose aws-vpn-net for network
- Click the "Attach network" button

![](img/21-upcloud-server-deployment-attach-private-network.png)

- Choose your preferred SSH keys
- Give your Cloud Server a suitable name

Once set, click the "Deploy" button.

## Test the VPN connection

Now that you have created the site-to-site VPN connection between your UpCloud and AWS environments and set up servers on both sides, it’s time to put the connection to the test.

Start by connecting to your UpCloud server using SSH. The instructions for this are on your Cloud Server details overview page.

Next, on the AWS side, head to the following section:

EC2 -> Instances (running) -> instance ID of the created instance

Find the Private IPv4 address of your EC2 instance.

Ping the address from the SSH session.

If the destination instance responds, you are all set!

![](img/22-upcloud-to-aws-ping.png)

## Summary

Congratulations! You should now have successfully connected your UpCloud infrastructure to your AWS resources, creating your multi-cloud platform.
