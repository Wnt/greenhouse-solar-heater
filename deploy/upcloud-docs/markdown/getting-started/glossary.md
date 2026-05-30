# Cloud Computing Glossary

Cloud computing glossary is a reference guide to the terms, concepts, and technologies used in modern cloud infrastructure. For anyone evaluating cloud providers, designing systems, or managing workloads, understanding this vocabulary is essential.

This glossary focuses on how cloud infrastructure actually works in practice. It covers core areas such as compute, storage, networking, security, and data governance, with clear explanations of how each concept affects performance, cost, reliability, and control.

Here you will find definitions for commonly searched terms like cloud computing, servers, latency, and autoscaling, along with more advanced topics such as data sovereignty and multi-cloud. Each entry is written to answer not just “what is it,” but “when does it matter” and “why should you care.”

Use this glossary to:

- Compare cloud providers and pricing models
- Understand infrastructure performance and limitations
- Plan and optimize architectures
- Navigate security, compliance, and data residency requirements

If a term impacts how your cloud environment runs, scales, or is billed, it’s covered here.

---

## **A**

### **Anti-Affinity**

A configuration rule that ensures specific workloads or instances are placed on separate physical hosts. This reduces the risk that a single hardware failure impacts multiple components. It is commonly used with multi-zone deployments to improve availability.

### **API (Application Programming Interface)**

A set of rules that allows different software systems to communicate. In cloud environments, APIs are used to provision servers, manage storage, automate infrastructure, and integrate services. Most platforms are API-first, enabling full automation.

### **Artificial Intelligence (AI)**

The simulation of human intelligence in machines. In cloud contexts, AI is used for prediction, classification, natural language processing, and automation, typically backed by scalable compute and data pipelines.

### **Autoscaling**

A feature that automatically adjusts compute resources based on demand. It increases capacity during spikes and reduces it during low usage, balancing performance and cost based on metrics like CPU or request rate.

### **Availability Zone**

An isolated location within a region designed to improve fault tolerance. Distributing workloads across zones helps protect against localized failures such as power or network outages.

---

## **B**

### **Backend**

The server-side part of an application that handles business logic, data processing, and integration with databases and services. Backends are typically built for reliability, scalability, and secure data handling.

### **Backup**

A copy of data stored separately from the original. Backups are used to restore systems after data loss, corruption, or failure and are a core part of disaster recovery strategies. They can be scheduled, incremental, or on-demand.

### **Bandwidth**

The amount of data that can be transferred over a network in a given period, typically measured in Mbps or Gbps. Bandwidth limits influence how quickly users can access services and how systems exchange data.

### **Bare Metal Server**

A physical server dedicated to a single tenant. It offers full control over hardware and predictable performance, often used for performance-sensitive or compliance-heavy workloads.

### **Block Storage**

A storage system that stores data in fixed-size blocks. It is commonly used for databases and transactional workloads that require consistent performance and low latency.

---

## **C**

### **Cloud Pricing**

The cost structure for cloud services. Models include pay-as-you-go, subscription, or resource-based billing. Pricing is typically tied to compute, storage, network usage, and optional managed services. Understanding pricing components is critical for forecasting costs and avoiding unexpected charges.

### **Cloud Cost Optimization**

The process of reducing cloud spend while maintaining performance. This includes right-sizing resources, removing unused capacity, selecting appropriate pricing models, and optimizing data transfer patterns. Effective cost optimization requires continuous monitoring and adjustment.

### **CLI (Command-Line Interface)**

A text-based interface used to interact with systems by typing commands. In cloud environments, CLIs enable automation, scripting, and fast resource management without a graphical interface, making them essential for DevOps workflows.

### **Changelog**

A record of changes made to software or services over time, including new features, bug fixes, and breaking changes. Reviewing changelogs helps teams understand impact before deploying updates.

### **Credit**

Prepaid usage or monetary value applied to a cloud account. Credits are often provided for trials or promotions and are consumed as services are used, typically with defined expiration or usage rules.

### **Cloud**

A general term for computing resources delivered over the internet instead of on-premises hardware. This includes servers, storage, networking, and managed services, typically billed based on consumption.

### **Cloud Application**

Software designed to run in cloud environments. These applications are built to scale horizontally, tolerate failure, and operate across distributed infrastructure.

### **Cloud Computing**

The delivery of computing resources such as servers, storage, and networking over the internet on demand. It enables rapid provisioning, elasticity, and usage-based billing.

### **Cloud Hosting**

A hosting model where applications run on virtualized infrastructure rather than a single physical server, improving scalability, redundancy, and availability.

### **Cloud Migration**

The process of moving applications, data, or workloads to the cloud. Common approaches include lift-and-shift, replatforming, and refactoring depending on desired outcomes.

### **Cloud Native**

An approach to building applications specifically for cloud environments using containers, microservices, and automated deployment practices.

### **Cloud Platform**

A set of services that provides infrastructure and tools for building, deploying, and managing applications in the cloud.

### **Cloud Service Provider**

A company that delivers cloud infrastructure and services, operating data centers and offering compute, storage, networking, and managed services.

### **Cloud Storage**

A service that stores data remotely and makes it accessible over the internet with scalable capacity and durability.

### **Cloud Server**

A virtual machine in a cloud environment with configurable CPU, memory, and storage. It can be scaled and managed programmatically.

### **Container**

A lightweight unit that packages an application and its dependencies to ensure consistent execution across environments.

### **Content Delivery Network (CDN)**

A distributed network that delivers content from locations closer to users, reducing latency and improving performance for global applications.

### **Control Panel (Cloud)**

A web interface for provisioning, configuring, and monitoring cloud resources without using APIs directly.

### **CPU (Central Processing Unit)**

The component responsible for executing instructions. In cloud environments, CPU allocation directly affects application performance and processing capacity.

---

## **D**

### **Data**

Information stored, processed, and transmitted by systems, including files, databases, logs, and application state.

### **Database**

An organized system for storing and querying data efficiently. Databases require reliable storage, indexing, and backup strategies.

### **Data Center**

A facility that houses servers, storage, and networking equipment. Providers operate multiple locations to deliver low latency and redundancy.

### **Data Control**

The ability to determine how data is stored, accessed, and managed, including location, permissions, and lifecycle policies.

### **Data Governance**

Policies and processes that ensure data is handled securely and in compliance with regulations, including access control and auditing.

### **Data Jurisdiction**

The legal authority that applies to data based on where it is stored or processed, affecting compliance and access rights.

### **Data Locality**

The practice of keeping data close to where it is used to reduce latency and improve performance.

### **Data Residency**

The physical location where data is stored, often chosen to meet regulatory or performance requirements.

### **Data Sovereignty**

The concept that data is subject to the laws of the country where it resides.

### **Dedicated Server**

A physical server used exclusively by one customer, providing isolation, control, and predictable performance.

### **Developer**

An individual who builds and maintains applications and systems, often using APIs, SDKs, and infrastructure tools.

---

## **E**

### **Egress Fee**

A charge applied when data is transferred out of a cloud environment to the public internet or another provider. Egress costs can significantly impact total cloud spend, especially for data-intensive applications, making architecture and traffic patterns important considerations.

### **Encryption at Rest**

A security practice where stored data is encrypted on disk. This ensures that even if physical storage is accessed without authorization, the data remains unreadable without the appropriate keys.

### **Encryption in Transit**

A security measure that encrypts data while it is being transmitted between systems, protecting it from interception or tampering during transfer.

### **Edge Computing**

A model where data processing occurs closer to the source, reducing latency and bandwidth usage for real-time applications.

---

## **F**

### **Frontend**

The user-facing part of an application responsible for presentation and interaction. It communicates with backend services via APIs and plays a key role in user experience and performance perception.

### **Free Trial**

A limited-time or usage-based offering that allows users to evaluate services before committing to a paid plan. It is commonly used to test performance, usability, and feature coverage in real-world scenarios.

### **File Storage**

A storage system that organizes data in a hierarchical structure, commonly used for shared access and traditional applications that rely on file paths and directories.

### **Firewall**

A security system that monitors and controls network traffic based on rules, protecting systems from unauthorized access and potential threats.

### **Floating IP**

A static IP address that can be reassigned between servers, commonly used for failover, maintenance, and high availability architectures.

### **Low-Latency**

Refers to infrastructure designed to minimize delay in data processing or transmission. Low latency is critical for real-time applications such as streaming, gaming, and financial systems.

---

## **G**

### **GPU (Graphics Processing Unit)**

A processor optimized for parallel computation, commonly used for machine learning, data processing, and rendering.

### **GPU Server**

A cloud server equipped with GPUs for compute-intensive workloads such as AI training and inference.

---

## **H**

### **High Availability (HA)**

A design approach that minimizes downtime through redundancy and failover mechanisms, ensuring systems remain operational during failures.

### **Host**

A physical or virtual machine that runs applications and services, forming the foundation of compute infrastructure.

### **Hybrid Cloud**

An environment that combines public cloud infrastructure with private systems, allowing workloads to be distributed based on performance, cost, or compliance needs.

### **Hyperscaler**

A cloud provider operating large-scale, highly automated infrastructure across global regions. These providers typically offer extensive service portfolios and massive scalability.

---

## **I**

### **Ingress**

Incoming network traffic entering a system or network. It is typically controlled through routing rules, firewalls, and load balancers.

### **Instance**

A virtual server running in a cloud environment with defined compute, memory, and storage resources. Instances are the primary unit of compute consumption.

### **Initialization**

The process of preparing a system or resource for use, including configuration, provisioning, and bootstrapping steps.

### **Infrastructure as a Service (IaaS)**

A cloud model where users provision and manage virtualized infrastructure such as servers, storage, and networking.

### **Internet of Things (IoT)**

A network of connected devices that collect and exchange data, often relying on cloud services for processing, storage, and analytics.

### **IP Address**

A unique identifier assigned to devices on a network to enable communication between systems.

### **IOPS (Input/Output Operations Per Second)**

A metric that measures how many read and write operations a storage system can perform. It is critical for evaluating storage performance for databases and transactional workloads.

---

## **K**

### **Kubernetes**

An open-source platform for managing containerized applications, automating deployment, scaling, and operations.

### **Kubernetes Cluster**

A group of nodes that run containerized applications under Kubernetes management, including control plane and worker nodes.

---

## **M**

### **Multi-Factor Authentication (MFA)**

A security method requiring two or more forms of verification, adding protection beyond passwords and reducing the risk of unauthorized access.

### **Metadata**

Data that describes other data, such as creation time, ownership, or configuration details. It is often used for management, organization, and automation.

### **Machine Learning**

A subset of AI where systems learn from data to improve performance without explicit programming.

### **Managed Databases**

A database service where maintenance tasks such as backups, updates, and scaling are handled by the provider, reducing operational overhead.

### **Managed Kubernetes**

A service where the Kubernetes control plane is managed by the provider, allowing users to focus on applications rather than infrastructure.

### **MaxIOPS Storage**

High-performance block storage designed for consistent and high input/output operations, suited for latency-sensitive workloads such as databases.

### **Multi-Cloud**

The use of multiple cloud providers within a single architecture to improve resilience, avoid vendor lock-in, and optimize performance.

---

## **N**

### **Node**

A machine within a distributed system that runs workloads and communicates with other nodes.

### **NAT Gateway**

A service that enables outbound internet access for private resources while preventing inbound connections, improving security for internal systems.

### **Network Latency**

The delay between sending a request and receiving a response, directly impacting application responsiveness.

### **Network Throughput**

The amount of data transferred over a network in a given time, affecting how quickly large datasets can be moved.

### **Network Isolation**

The separation of workloads into distinct network segments to improve security and limit the impact of potential issues.

---

## **O**

### **OpenSearch**

An open-source search and analytics engine used for log analysis, search, and observability workloads in distributed systems.

### **Object Storage**

A storage model that manages data as objects, suitable for large-scale unstructured data such as media, backups, and archives.

### **Operating System (OS)**

Software that manages hardware resources and provides services for applications, acting as the interface between software and hardware.

---

## **P**

### **Peering**

A network connection between two networks that allows direct data exchange, improving performance, reducing latency, and avoiding public internet routes.

### **PostgreSQL**

An open-source relational database system known for reliability, extensibility, and strong standards compliance.

### **Platform as a Service (PaaS)**

A cloud model that provides a platform for developing and deploying applications without managing underlying infrastructure.

### **Private Cloud**

A cloud environment dedicated to a single organization, offering greater control, security, and customization.

### **Private Networking**

An isolated network environment for secure communication between resources without exposure to the public internet.

### **Public Cloud**

Cloud services delivered over the internet to multiple customers with logical isolation between tenants.

---

## **R**

### **Routing**

The process of directing network traffic between systems or networks based on defined rules and paths.

---

## **S**

### **Self-Service**

A model where users provision and manage resources independently through a control panel or API. This reduces dependency on provider support and enables faster iteration.

### **Subaccount**

A separate account within a main cloud account used to isolate projects, teams, or billing. It helps organize resources and enforce access control.

### **SDK (Software Development Kit)**

Tools, libraries, and documentation used to build applications and integrate with cloud services. SDKs simplify working with APIs and accelerate development.

### **Secure Socket Shell (SSH)**

A protocol for securely accessing and managing remote systems over encrypted connections, commonly used for server administration.

### **SLA (Service Level Agreement)**

A contract defining uptime, performance, and support commitments. SLAs often include guarantees and compensation terms.

### **Simple Backup**

A service for automated and on-demand data backups, enabling quick recovery in case of data loss or system failure.

### **Software as a Service (SaaS)**

Software delivered over the internet and managed by the provider, allowing users to access applications without managing infrastructure.

### **SSD (Solid State Drive)**

A storage device that provides fast performance and low latency compared to traditional hard drives, improving application responsiveness.

### **Scale-Up vs Scale-Out**

Two approaches to scaling: increasing resources on a single machine or adding more machines to distribute load and improve resilience.

### **Snapshot**

A point-in-time copy of data used for backup, recovery, and cloning environments.

### **Secure Boot**

A feature that ensures only trusted software runs during system startup, protecting systems from low-level threats.

---

## **T**

### **Terraform**

An infrastructure as code tool used to define and manage cloud resources through configuration files. It enables repeatable, version-controlled deployments.

### **Total Cost of Ownership (TCO)**

The overall cost of running cloud infrastructure over time, including direct expenses, operational overhead, and indirect costs such as downtime or maintenance.

---

## **V**

### **Valkey**

An open-source in-memory data store used for caching, messaging, and real-time data processing, designed for high performance and low latency.

### **Vendor Lock-in**

Dependence on a provider that makes it difficult to migrate to another platform. It can limit flexibility, increase costs, and impact long-term strategy.

### **Virtual Machine (VM)**

A software-based computer running on virtualized hardware, allowing multiple operating systems to share a single physical machine.

### **Virtual Private Cloud (VPC)**

An isolated network environment within a public cloud, providing control over IP ranges, routing, and access policies.

### **Virtual Private Server (VPS)**

A virtualized server that mimics a dedicated environment within shared hardware, offering flexibility and cost efficiency.

### **Virtualization**

Technology that enables multiple virtual machines to run on a single physical system, improving resource utilization and scalability.

### **Volume (Storage)**

A unit of persistent storage that can be attached to a compute instance, typically used in block storage systems. Volumes allow data to persist independently of the lifecycle of a server.

### **VPN Gateway**

A service that enables secure, encrypted connections between networks, often used to connect on-premises infrastructure with cloud environments.

---

## **W**

### **Workload**

An application or process running on cloud infrastructure with specific compute, storage, and networking requirements. Different workloads require different architectures and performance characteristics.

---
