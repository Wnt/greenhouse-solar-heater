# Deploying ingress-nginx with cert-manager on Managed Kubernetes

By default Kubernetes services with `type: LoadBalancer` are exposed over Managed Load Balancer
and a HTTP(S) frontend in Managed Kubernetes as a Layer 7 proxy. However, use cases that require more fine-grained
control over ingress traffic often require a separate ingress controller to be run in between.
Typically this involves setting up TLS certificates, and requires Managed Load Balancer to be run
in TCP load balancing mode as a Layer 4 Proxy.

This guide presents the following steps:

- Installing ingress-nginx through a Helm chart
- Installing cert-manager through a Helm chart
- Exposing ingress-nginx over TCP load balancing
- Configuring cert-manager to issue TLS certificates dynamically through Let's Encrypt
- Creating an example service, exposed through ingress-nginx and HTTP(S)

## Prerequisites

Create a Managed Kubernetes cluster and configure command-line access to configure cluster resources with `kubectl`.

See [Deploying Managed Kubernetes cluster with Terraform](/docs/guides/deploy-managed-kubernetes-cluster-terraform.md) to get started.

## Deploy example workload

Create an example deployment. Any application will do. In this case we're using the [Hello UKS app](https://github.com/UpCloudLtd/hello-container). The app is exposed as a ClusterIP service, which ingress-nginx will forward traffic to.

```
kubectl create deployment --image=ghcr.io/upcloudltd/hello hello-uks
kubectl expose deployment hello-uks --port=80 --target-port=80 --type=ClusterIP
```

## Installing ingress-nginx

First, create a `ingress-nginx-values.yaml` configuration file. We will use this to extend
default values from the ingress-nginx Helm chart.

```
controller:
  service:
    annotations:
      service.beta.kubernetes.io/upcloud-load-balancer-config: |
          {
              "frontends": [
                  {
                      "name": "http",
                      "mode": "tcp"
                  },
                  {
                      "name": "https",
                      "mode": "tcp"
                  }
              ],
              "backends": [
                {
                  "name": "https",
                  "properties": {
                    "outbound_proxy_protocol": "v2"
                  }
                },
                {
                  "name": "http",
                  "properties": {
                    "outbound_proxy_protocol": "v2"
                  }
                }
              ]
          }
  config:
    use-forwarded-headers: "true"
    compute-full-forwarded-for: "true"
    use-proxy-protocol: "true"
    real-ip-header: "proxy_protocol"
```

If you want to customise any other configuration options, you can run the following command
to list all available parameters:

```
helm show values ingress-nginx --repo https://kubernetes.github.io/ingress-nginx
```

Once your `ingress-nginx-values.yaml` file is ready you can proceed to install `ingress-nginx`:

```
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --values ingress-nginx-values.yaml
```

This command deploys all required components to the `ingress-nginx` namespace. It also deploys a
UpCloud Managed Load Balancer. Run the following command to wait until the Managed Load Balancer
is ready:

```
$ kubectl get svc -n ingress-nginx ingress-nginx-controller
...
ingress-nginx-controller             LoadBalancer   10.132.49.181   lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com   80:30359/TCP,443:31695/TCP   4m46s
```

Finally validate that you can access the default backend for `ingress-nginx`:

```
$ curl -is http://lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
HTTP/1.1 404 Not Found

<html>
<head><title>404 Not Found</title></head>
<body>
<center><h1>404 Not Found</h1></center>
<hr><center>nginx</center>
</body>
</html>
```

HTTP 404 error is expected, because there is no matching Ingress resource for the hostname.

You can also connect to `ingress-nginx` with HTTPS as it deploys a self-signed certificate by default:

```
$ curl -vkis https://lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
...
* Server certificate:
*  subject: O=Acme Co; CN=Kubernetes Ingress Controller Fake Certificate
...
```

## Optional: Create DNS entries

If you want to use any custom DNS names in this guide you will need the following DNS records:

```
name.domain.tld. IN CNAME 60 lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
```

## Installing cert-manager

Next we will install `cert-manager` for managing, provisioning and renewing certificates
for any Ingress resource that utilises TLS. First, configure the cert-manager Helm repository:

```
helm repo add jetstack https://charts.jetstack.io --force-update
```

Install the Helm chart to `cert-manager` namespace:

```
helm install \
  cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.15.1 \
  --set crds.enabled=true
```

## Configuring cert-manager

Next we will configure two certificate issuers into the cluster. Both are of type `ClusterIssuer`
which means any namespace in the cluster may request TLS certificates by using these issuers.
If you want more fine-grained control, you may want to use `Issuer` type instead, which is scoped
per namespace.

First, create a certificate issuer that utilises the Let's Encrypt staging environment. Modify
your e-mail address in the following YAML:

```
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    # The ACME server URL
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    # Email address used for ACME registration
    email: <your-email-address-here>
    # Name of a secret used to store the ACME account private key
    privateKeySecretRef:
      name: letsencrypt-staging
    # Enable the HTTP-01 challenge provider
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
```

You can validate that your issuer was created successfully by running `kubectl describe clusterissuer letsencrypt-staging`.

Proceed to expose the example application through the ingress controller, by utilising staging
certificates. If you are using a custom domain name you will need to modify the host fields accordingly. In the example YAML we will
use the Managed Load Balancer hostname that is readily available.

```
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello-uks
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-staging"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
    secretName: hello-uks-tls
  rules:
  - host: lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hello-uks
            port:
              number: 80
```

If you are using namespace scoped issuer, remember to use `cert-manager.io/issuer` as the annotation
instead of `cert-manager.io/cluster-issuer`.

Then wait until the certificate has been provisioned. You can run `kubectl get certificate -w` while
waiting.

As a final step, validate that the staging certificates are properly used and that you
can connect to the demo application.

```
$ curl -vk https://lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
...
* Server certificate:
*  subject: CN=lb-0a020dde036a48db923821e7c52d25a1-1.upcloudlb.com
...
*  issuer: C=US; O=(STAGING) Let's Encrypt; CN=(STAGING) Wannabe Watercress R11

Hello! 👋

Hostname: hello-uks-99bd7856f-6zx5s
Address:  192.168.6.51:80

UpCloudLtd / hello-container at v1.1.0
```

The Let's Encrypt staging issuers are not part of trusted certificates and you will receive a certificate error on your clients. Once
you can successfully utilise cert-manager on the staging environment, you can move on to doing
the same thing on their production issuer, which is a reputable and trusted TLS authority.

## cert-manager in production use

Create a new production grade issuer. Note that Lets Encrypt has
[very strict rate limits](https://letsencrypt.org/docs/rate-limits/) for production use.

Create the issuer by applying the following manifest:

```
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    # The ACME server URL
    server: https://acme-v02.api.letsencrypt.org/directory
    # Email address used for ACME registration
    email: <your-email-address-here>
    # Name of a secret used to store the ACME account private key
    privateKeySecretRef:
      name: letsencrypt-prod
    # Enable the HTTP-01 challenge provider
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
```

Validate that your issuer was created success fully by running `kubectl describe clusterissuer letsencrypt-prod`.

Modify the previous example `Ingress` object to use production grade Let's Encrypt:

```
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello-uks
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
    secretName: hello-uks-tls
  rules:
  - host: lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hello-uks
            port:
              number: 80
```

Wait until certificate has been provisioned. You can check the progress by running `kubectl get certificate -w`.

And as a final step you can run the same `curl` command as above but without the `-k / --insecure` flag.

```
$ curl -v https://lb-0abba020acdc036a48db923821e7c555d25a1-1.upcloudlb.com
...
* Server certificate:
*  subject: CN=lb-0a020dde036a48db923821e7c52d25a1-1.upcloudlb.com
...
*  issuer: C=US; O=Let's Encrypt; CN=R10

Hello! 👋

Hostname: hello-uks-99bd7856f-6zx5s
Address:  192.168.6.51:80

UpCloudLtd / hello-container at v1.1.0
```

## ingress-nginx in production use

By default `ingress-nginx` is deployed as a Deployment with a single replica. Also the
Managed Load Balancer is deployed by using the Development plan. For production use it is
recommended to deploy more than one replica and set Managed Load Balancer to use a production
grade plan.

In order to upgrade your setup you will need to modify your `ingress-nginx-values.yaml` to contain the following:

```
controller:
  replicaCount: 3
  service:
    annotations:
      service.beta.kubernetes.io/upcloud-load-balancer-config: |
          {
              "plan": "production-small",
              "frontends": [
                  {
                      "name": "http",
                      "mode": "tcp"
                  },
                  {
                      "name": "https",
                      "mode": "tcp"
                  }
              ],
              "backends": [
                {
                  "name": "https",
                  "properties": {
                    "outbound_proxy_protocol": "v2"
                  }
                },
                {
                  "name": "http",
                  "properties": {
                    "outbound_proxy_protocol": "v2"
                  }
                }
              ]
          }
  config:
    use-forwarded-headers: "true"
    compute-full-forwarded-for: "true"
    use-proxy-protocol: "true"
    real-ip-header: "proxy_protocol"
```

Re-run the Helm command and wait until it has finished:

```
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --values ingress-nginx-values.yaml
```
