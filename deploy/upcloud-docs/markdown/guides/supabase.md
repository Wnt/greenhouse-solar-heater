# Supabase on Kubernetes: A Scalable Open-Source Firebase Alternative

# Why Deploy Supabase on Kubernetes?

**Supabase** is a popular **Backend as a Service (BaaS)** solution. It describes itself as an open-source alternative to Firebase.

In recent years, its out-of-the-box features, such as authentication, database storage, file storage, and real-time APIs, paired with its FOSS licensing model, have made it a very attractive solution for Web App developers and Mobile App developers seeking to get their projects started quickly and easily.

However, [self-hosting Supabase](https://github.com/supabase/supabase) will require the deployment of several underlying infrastructure components, which can be time-consuming and prone to error.

When App Developers consider the question of **Supabase vs Firebase**, one key consideration is **whether the setup can scale reliably as your project grows**. An effective approach to making Supabase scalable is to deploy Supabase on **Kubernetes**, which provides built-in support for scaling, high availability, and automated recovery.

One popular way to [deploy Supabase on Kubernetes is to use Helm charts](https://github.com/supabase-community/supabase-kubernetes). However, this method requires prior knowledge of [Helm](https://helm.sh/). This guide shows how to deploy Supabase on UpCloud’s [Managed Kubernetes Service (UKS)][1] and [Managed Object Storage](/docs/products/managed-object-storage.md) using a [ready-to-run script](https://github.com/UpCloudLtd/paasup/tree/main/supabase), which abstracts away the complexities of Kubernetes, Helm, Object Storage and other tools, wires it all together and gets you **up and running within a few minutes**.

The idea is to deliver all the convenience of Supabase on top of the flexibility, scalability and self-healing powers of Kubernetes, but *without* having to know much about Kubernetes.

## What is this good for?

This setup is great for:

- **Web and Mobile App Development:** Full-featured backend (auth, DB, storage, APIs) to accelerate development and focus on the client-side experience —while running on infra that will be able to affordably scale later.
- **Granular Security:** Leveraging Row-Level Security (RLS) in PostgreSQL.
- **Real-time Applications:** Utilizing Supabase's Realtime engine for instant data synchronization with the database, essential for collaborative features or live updates.

## What You'll Get

[This script](https://github.com/UpCloudLtd/paasup/tree/main/supabase) sets up a Supabase environment on UpCloud Managed Kubernetes which includes:

- **Kubernetes Cluster**: A small [UKS (UpCloud Kubernetes Service) - [/docs/products/managed-kubernetes.md) cluster to run Supabase in, which you can later scale as your project and demand grows. - **PostgreSQL Database**: A [Postgres](https://postgresql.org) instance backed by [Kubernetes Persistent Volume Claims (PVCs) - [https://kubernetes.io/docs/concepts/storage/persistent-volumes/) to ensure data durability. - **Supabase Studio**: A dashboard to manage your database schema, authentication settings, and file storage buckets. - **Kong API Gateway**: [Kong](https://github.com/Kong/kong) is a cloud-native API Gateway used to handle routing and security of your Supabase services.
- **Real-time Engine and REST APIs**: Enables real-time subscription to database changes and simple CRUD operations.
- **File Storage**: Integrated with UpCloud's S3-compatible [Managed Object Storage](/docs/products/managed-object-storage.md), configurable via environment variables.
- **Authentication Service**: Secure user management with email/password sign-in, social logins, and [JWT](https://www.rfc-editor.org/rfc/rfc7519)-based sessions, fully integrated out of the box.

## Requirements

Ensure you have the following prerequisites ready:

- An UpCloud account with API access.
- Tools:
  - `upctl`: The [UpCloud CLI](https://upcloudltd.github.io/upcloud-cli/), which you'll have to preconfigure your UpCloud credentials.
  - `git`: The Git CLI, which we'll use to get the script we'll use to automate the deployment.
  - `helm`: The [Helm CLI](https://helm.sh/docs/intro/install/), which will be used by the script in order to deploy Supabase.
  - `kubectl`: The [Kubernetes CLI](https://kubernetes.io/docs/tasks/tools/), which will be used by the script to communicate with the new Kubernetes cluster on which we'll run Supabase.
  - `jq`: The [JQ CLI](https://jqlang.org/download/), which will be used by the script to parse outputs from one command in order to pass them over to the next one and piece the whole thing together.

## Get the Code

In order to get you up and running as quickly and easily as possible, we provide a script that deploys all the necessary infrastructure, an [Managed Object Storage](/docs/products/managed-object-storage.md) service, a small [Kubernetes](/docs/products/managed-kubernetes.md) cluster running Postgres and the Supabase components, and a [Managed Load Balancer](/docs/products/managed-load-balancer.md). If you wish to have a look at the script —though this is not really necessary— the repository is hosted in our public Github org [here](https://github.com/UpCloudLtd/paasup/tree/main/supabase)

```
git clone https://github.com/UpCloudLtd/paasup.git
cd paasup/supabase
```xml

## Configure your Deployment

Before deploying, you'll need to first set some environment variables defined in the `deploy_supabase.env` file. These will allow you to define your Supabase username/password, your Postgres password, connect to the s3-compatible Object Storage of your choice or set up your SMTP server.

Example content:

```shell
# Enable/Disable and configure supabase services
# Studio service configuration
DASHBOARD_USERNAME=supabase
DASHBOARD_PASSWORD=""                               # If not set, the script will generate one password
# Database service configuration
POSTGRES_PASSWORD=""                                # If not set, the script will generate one password
# S3 service and configuration
ENABLE_S3=true                                      # Controls if s3 servcice is deployed
S3_KEY_ID=AccessKey                                 # Access key for the user with access to this upcloud object storage
S3_ACCESS_KEY=SecretKey                             # Secret key for the user with access to this upcloud object storage
S3_BUCKET=supabase-bucket                           # Must be a bucket that already exists in your objet storage
S3_ENDPOINT=https://0vg6c.upcloudobjects.com        # Your object storage url ( S3 endpoint)
S3_REGION=europe-1                                  # Region where your upcloud object storage is
# SMTP Notifications
ENABLE_SMTP=false
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
[email protected]
SMTP_PASS=secretpassword
SMTP_SENDER_NAME="MyApp <[email protected]>"
```

Adjust these variables to tailor your Supabase deployment exactly to your storage, email, and security preferences.

## Deploy Supabase

To deploy, use the provided script `deploy_supabase.sh`:

```
./deploy_supabase.sh <location> <app_name>
```

For example:

```
./deploy_supabase.sh es-mad1 supak8s
```

This single command will:

1. Create a new [private network](/docs/products/networking/sdn-private-networks.md) and Kubernetes cluster on [UpCloud Managed Kubernetes Service (UKS) - [/docs/products/managed-kubernetes.md). - **Note:** The default cluster will have **a single 2xCPU-4GB** worker node, so you can get started for **very little cost**, *but* **retain the ability to scale your Supabase** deployment as your project and demand grows. ![Output of the script showing network and Kubernetes cluster creation](pic1.png)

Network and Kubernetes cluster creation —This may take a few minutes to finish.

2. Download the **Kubernetes** `kubeconfig.yaml` file, so it can make deployments to your cluster on your behalf.

![Output of the script showing the download of the kubeconfig file](pic2.png)

Kubeconfig download.

3. Deploy Supabase using **Helm**.
   - **Note:** This will also deploy Postgres.

![Output of the script showing Supabase on Kubernetes installation using Helm](pic3.png)

Supabase installation on Kubernetes, using Helm under the hood.

4. Create an [UpCloud Managed Load Balancer](/docs/products/managed-load-balancer.md) to expose the **Supabase Dashboard**.

![Output of the script showing the creation of the Kubernetes service as a managed managed loadbalancer (LBaaS) to expose the Supabase Dashboard](pic4.png)

Expose the Supabase Dashboard as Kubernetes service using UpCloud Managed LBaaS

5. Apply the configuration values set by you in the `deploy_supabase.env` file.
   - **Note:** This is what will wire **Supabase file storage** to your [UpCloud Managed Object Storage](/docs/products/managed-object-storage.md) service.

Once the script is done, you will see all your connection details in the output.

```
Supabase deployed successfully!
Public endpoint: http://lb-0ab60...43c87-1.upcloudlb.com:8000
Namespace: supabase-app1-es-mad1
ANON_KEY: eyJhbGciOi...RMOOrZLYcr0
SERVICE_ROLE_KEY: eyJhbGciOi...2iFZqud24
POSTGRES_PASSWORD: supabase
POOLER_TENANT_ID: tenant-7b141b
DASHBOARD_USERNAME: supabase
DASHBOARD_PASSWORD: ********
S3 ENABLED: true
S3_BUCKET: supabase-bucket
S3_ENDPOINT: https://******.upcloudobjects.com
S3_REGION: europe-1
SMTP ENABLED: false
SMTP_HOST: not set
SMTP_PORT: not set
SMTP_USER: not set
SMTP_SENDER_NAME: not set
```

## Connect to your Supabase Deployment

Open a web brower and navigate to the URL printed in the script's output as you `Public endpoint`. It will roughly look like this:

`http://lb-0ab60...43c87-1.upcloudlb.com:8000`

Copy and paste this URL into your web browser.

![Output of the script pointing to an UpCloud Managed Load Balancer URL](pic8.png)

Supabase Dashboard URL.

You will be prompted for your username and password.
Type in the credentials from the script's output.

![Supabase Dashboard prompt for username and password](pic6.png)

Supabase Dashboard login.

Once inside, you should see the **Supabase Dashboard**.

![Supabase dashboard, running on Kubernetes and exposed through a managed Load Balancer](pic7.png)

Supabase Dashboard, running on Kubernetes.

**API Access:** In order to connect your frontend apps to your new deployment's endpoints, use the `ANON_KEY` and `SERVICE_ROLE_KEY`, also from the script's output.

![Output of the script showing the API credentials](pic10.png)

API credentials.

**Congrats** 🎉 You now have everything you need in order to start developing and testing your backend database and endpoints, and to start integrating your web or mobile apps right away.

## Advanced Customization

Since our script leverages **Helm** under the hood, for additional customization you can simply create a file called `values.custom.yaml` inside the `/supabase` directory. This allows you to override specific Helm chart settings beyond what's provided in `deploy_supabase.env`.

For example, to change the s3 supabase base folder and the access key:

```
storage:
  environment:
    TENANT_ID:  "supabase1"
secret:
  s3:
    accessKey: "xyz"
```

If present, the script automatically applies this configuration during deployment.

Please note that this type of customization will require that you have a basic understanding of the Helm charts used to deploy Supabase.

## Make Changes to your Supabase Deployment

Once deployed, if you wish to change anything about your existing deployment, the script provided makes this straightforward with the use of the `--upgrade` flag.

```
./deploy_supabase.sh --upgrade <location> <app_name>
```

Under the hood, the script will leverage a `helm upgrade` command and use any values you place in a file `values.custom.yaml`.

## Summary

This script means to significantly simplify the deployment of **Supabase** on UpCloud, using both **UpCloud Managed Kubernetes (UKS)** and **Managed Object Storage** to provide a robust, persistent, and customizable environment, that will be able to grow with your project.

We aim to iterate over this guide (and soon others like it), so if you have any feedback or would like to contribute, please raise an issue or MR over our new [Stacks repository](https://github.com/UpCloudLtd/paasup)
