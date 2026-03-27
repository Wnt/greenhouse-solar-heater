# Migrating from Ingress NGINX to Cilium Gateway API on UpCloud Managed Kubernetes

Ingress NGINX retirement was [announced](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) on November 11, 2025. Best-effort maintenance will continue until March 2026. After that, there will be no releases, bugfixes, or security updates. Existing deployments will keep working and artifacts remain available.

The Kubernetes project recommends moving to the [Gateway API](https://gateway-api.sigs.k8s.io/guides/getting-started/) or another ingress controller.

Gateway API is the Kubernetes project's successor to Ingress. It provides more flexible routing, clearer separation between platform and application responsibilities, and built-in support for capabilities like traffic splitting and header manipulation. On UpCloud Managed Kubernetes, Cilium's Gateway API support provides a compatible path forward.

UpCloud Managed Kubernetes uses Cilium as the default CNI. This guide shows how to enable the Gateway API in Cilium and verify that a Gateway can provision an UpCloud Load Balancer.

## Prerequisites

- A Managed Kubernetes cluster running version 1.32 or later.
  - **On 1.30 or 1.31?** You can upgrade in place - one minor version at a time from the UpCloud Control Panel or [API](https://developers.upcloud.com/1.3/20-managed-kubernetes/#upgrade-cluster).
  - **On 1.29 or older?** Create a new 1.32+ cluster and [migrate your workloads with Velero](/docs/guides/migration-uks-velero.md).
- `kubectl` configured to access your cluster.
- `helm` v3 installed locally.

## Check if you are using Ingress NGINX

```
kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx
```

If you see results, you are currently using ingress-nginx.

## Install Gateway API CRDs

Install the Gateway API v1.2.0 standard CRDs:

```
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v1.2.0/config/crd/standard/gateway.networking.k8s.io_gatewayclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v1.2.0/config/crd/standard/gateway.networking.k8s.io_gateways.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v1.2.0/config/crd/standard/gateway.networking.k8s.io_httproutes.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v1.2.0/config/crd/standard/gateway.networking.k8s.io_referencegrants.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v1.2.0/config/crd/standard/gateway.networking.k8s.io_grpcroutes.yaml
```

Optional: TLSRoute is experimental and requires the experimental CRD:

```
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v1.2.0/config/crd/experimental/gateway.networking.k8s.io_tlsroutes.yaml
```

## Enable Gateway API in Cilium

On UpCloud Managed Kubernetes 1.32+, the default Cilium version already meets the v1.18+ requirement. You only need to enable Gateway API.

Back up your current values:

```
helm get values cilium -n kube-system > cilium_values_backup.yaml
```

Keep this file in case you need to roll back the Helm release.

Enable Gateway API:

```
helm repo add cilium https://helm.cilium.io
```

**Note:** If you receive an error that the repository already exists, you can safely skip the `repo add` command and proceed to `repo update`.

```
helm repo update

helm upgrade cilium cilium/cilium \
  --version 1.18.7 \
  --namespace kube-system \
  --reuse-values \
  --set gatewayAPI.enabled=true
```

**Important:** The `--version` flag pins the Helm chart to the 1.18.x line that ships with UpCloud Managed Kubernetes. Without it, Helm pulls the latest chart (currently 1.19), which requires additional upgrade steps and is not compatible with `--reuse-values`.

**Note:** kube-proxy replacement is already enabled by default on UpCloud Managed Kubernetes and does not need to be set explicitly.

Restart Cilium components:

```
kubectl -n kube-system rollout restart deployment/cilium-operator
kubectl -n kube-system rollout restart ds/cilium
```

Verify that Gateway API is enabled:

```
kubectl -n kube-system get configmap cilium-config -o yaml | grep -E "^\s*enable-gateway-api:"
```

You should see `enable-gateway-api: "true"`.

## Deploy a test Gateway

When you enable Gateway API, Cilium automatically creates a GatewayClass named `cilium`. Verify it exists:

```
kubectl get gatewayclass
```

You should see:

```
NAME     CONTROLLER                     ACCEPTED   AGE
cilium   io.cilium/gateway-controller   True       1m
```

Create `test-gateway.yaml`:

```
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-test-gateway
  namespace: default
spec:
  gatewayClassName: cilium
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: All
```

Apply and check status:

```
kubectl apply -f test-gateway.yaml
kubectl get gateway my-test-gateway
kubectl -n default get svc
```

UpCloud will now provision a Managed Load Balancer, which takes about 2 minutes. You can monitor the progress in the UpCloud Control Panel under Load Balancers. When it finishes, the Gateway address and the Load Balancer Service should show a hostname.

Example:

```
NAME              CLASS    ADDRESS                       PROGRAMMED   AGE
my-test-gateway   cilium   lb-xxxx.upcloudlb.com         True         2m
```

## Migration strategy

1. Keep your existing Ingress running.
2. Deploy a Gateway and HTTPRoute alongside it.
3. Test the Gateway using a different hostname or internal testing.
4. Update DNS to point to the Gateway Load Balancer.
5. Monitor for issues.
6. Delete old Ingress objects after confirming stability.

## Migrating Ingress patterns to HTTPRoutes

Since every application is different, there is no single command to migrate everything. Use the reference examples below to translate your existing Ingress rules into Gateway API `HTTPRoute` objects.

**Prerequisite**: Make sure you have a Gateway running (as created in the "Deploy a test Gateway" section above).

Start by listing your Ingress objects:

```
kubectl get ingress -A
```

Choose the matching pattern

#### Pattern A: Simple path prefix

If your Ingress looks like this:

```
spec:
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
```

Create this HTTPRoute:

```
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web
  namespace: default
spec:
  parentRefs:
  - name: my-test-gateway # Name of your Gateway
  hostnames:
  - app.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: web
      port: 80
```

#### Pattern B: Multiple paths

If your Ingress routes multiple paths (e.g. `/api` and `/web`):

```
spec:
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /api
        ...
      - path: /web
        ...
```

Create this HTTPRoute:

```
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app
  namespace: default
spec:
  parentRefs:
  - name: my-test-gateway
  hostnames:
  - app.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: api-service
      port: 8080
  - matches:
    - path:
        type: PathPrefix
        value: /web
    backendRefs:
    - name: web-service
      port: 80
```

#### Pattern C: HTTPS / TLS

If you require HTTPS, you configure the TLS certificate on the **Gateway**, not the Route.

Create the secret:

```
kubectl create secret tls app-tls --cert=path/to.crt --key=path/to.key
```

Update your Gateway listener:

```
listeners:
- name: https
  protocol: HTTPS
  port: 443
  tls:
    mode: Terminate
    certificateRefs:
    - kind: Secret
      name: app-tls
```

**Important:** If you add an HTTPS listener that references a Secret that does not yet exist, the Gateway will report an `Invalid CertificateRef` error for that listener. This can prevent all traffic routing on the Gateway, including HTTP. Always ensure the TLS Secret exists before adding an HTTPS listener, or use cert-manager as described in [Using cert-manager with Gateway API](/docs/guides/gateway-api-migration#using-cert-manager-with-gateway-api-optional.md).

**Note:** If you use cert-manager, see [Using cert-manager with Gateway API](/docs/guides/gateway-api-migration#using-cert-manager-with-gateway-api-optional.md) below.

#### Pattern D: Cross-Namespace access

By default, a Gateway may not trust Routes from other namespaces. If you encounter permissions errors when attaching a Route in one namespace (e.g. `apps`) to a Gateway in another (e.g. `gateway-system`), you use a `ReferenceGrant`.

Create this in the Gateway's namespace:

```
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-apps-routes
  namespace: default # The namespace of the Gateway
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: apps # The namespace of the Route
  to:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: my-test-gateway # The name of the Gateway
```

## Verify the Migration

Once you have applied an `HTTPRoute`, check that the Gateway has accepted it and that traffic is flowing correctly.

Check the status of your route:

```
kubectl describe httproute <route-name> -n <namespace>
```

Scroll down to the Status section at the bottom. Under Conditions, verify that the Type fields `Accepted` and `ResolvedRefs` both have their Status set to `True`

Next, test the connectivity using your Gateway's external address. You can find this address by listing the Gateway:

```
kubectl get gateway my-test-gateway
```

Then, use `curl` or your browser to access the application through that hostname:

```
curl http://<GATEWAY-ADDRESS>/<your-path>
```

If you receive the expected response from your application, the migration for that route is complete.

## Routing TCP and UDP traffic

**Note**: `TCPRoute` and `UDPRoute` resources are not yet supported in Cilium's Gateway API implementation. This section describes the recommended standard approach for TCP/UDP load balancing.

The standard method to expose non-HTTP applications on UpCloud Managed Kubernetes is using a Kubernetes `Service` of type `LoadBalancer`. This creates a dedicated UpCloud Load Balancer for your TCP/UDP application.

**1. Deploy your TCP Workload**

Create a Deployment and Service. Note that `type: LoadBalancer` is used here instead of `ClusterIP`.

**Important:** You must include the `upcloud-load-balancer-config` annotation to explicitly set the mode to `tcp`. Without this, the Load Balancer defaults to HTTP mode and will reject raw TCP connections.

```
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tcp-echo
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: tcp-echo
  template:
    metadata:
      labels:
        app: tcp-echo
    spec:
      containers:
      - name: tcp-echo
        image: istio/tcp-echo-server:1.2
        ports:
        - containerPort: 9000
        args: [ "9000", "hello" ]
---
apiVersion: v1
kind: Service
metadata:
  name: my-tcp-service
  namespace: default
  annotations:
    service.beta.kubernetes.io/upcloud-load-balancer-config: |
      {
        "frontends": [
          {
            "name": "tcp-app",
            "mode": "tcp",
            "port": 9000
          }
        ]
      }
spec:
  type: LoadBalancer
  selector:
    app: tcp-echo
  ports:
    - name: tcp-app
      protocol: TCP
      port: 9000
      targetPort: 9000
```

**2. Verify Connectivity**

Get the external address of the service:

```
kubectl get svc my-tcp-service
```

Wait for the `EXTERNAL-IP` column to show a hostname (this takes about 2 minutes):

```
NAME             TYPE           CLUSTER-IP     EXTERNAL-IP             PORT(S)          AGE
my-tcp-service   LoadBalancer   10.96.123.45   lb-xxx.upcloudlb.com    9000:30123/TCP   2m
```

Once the Load Balancer is provisioned, test connectivity using `netcat` (nc):

```
echo "UpCloud" | nc lb-xxx.upcloudlb.com 9000
```

**Expected Output:**

```
hello UpCloud
```

For UDP services, the process is similar. Simply change the protocol in the Service spec and update the load balancer config mode.

```
annotations:
    service.beta.kubernetes.io/upcloud-load-balancer-config: |
      {
        "frontends": [
          {
            "name": "udp-app",
            "mode": "udp",
            "port": 9000
          }
        ]
      }
```

Note: Each Service of type LoadBalancer provisions its own UpCloud Managed Load Balancer, separate from any Gateway resources deployed.

## Customizing Load Balancer configuration with Gateway API

By default, the UpCloud Cloud Controller Manager provisions Load Balancers with HTTP mode on port 443. When using Gateway API with TLS termination in Cilium, you need to configure the Load Balancer to use TCP mode instead. This allows TLS connections to pass through to Cilium's Envoy proxy.

You can customize the Load Balancer configuration directly in your Gateway spec using the `infrastructure.annotations` field:

```
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-gateway
  namespace: default
spec:
  gatewayClassName: cilium
  infrastructure:
    annotations:
      service.beta.kubernetes.io/upcloud-load-balancer-config: |
        {
          "frontends": [
            {
              "name": "port-443",
              "mode": "tcp",
              "port": 443
            }
          ]
        }
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: All
  - name: https
    protocol: HTTPS
    port: 443
    hostname: app.example.com
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: app-tls
    allowedRoutes:
      namespaces:
        from: All
```

**Important notes:**

- The frontend `name` must match the Service port name that Cilium creates (typically `port-<number>`)
- For TLS termination with cert-manager, TCP mode is required to prevent certificate mismatches
- The annotation supports all UpCloud Load Balancer configuration options - see the [Load Balancer API documentation](https://developers.upcloud.com/1.3/17-managed-loadbalancer/) for details

This approach is recommended over post-creation annotations because:

- Everything is declarative in one file
- Changes can be tracked in version control
- No manual kubectl commands needed

## Using cert-manager with Gateway API (optional)

If you currently use cert-manager to provision TLS certificates for your Ingress resources, you can continue using it with Gateway API. However, there are several important configuration steps required.

**Step 1: Install cert-manager with Gateway API support**

cert-manager's Gateway API support is disabled by default. Enable it during installation:

```
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true \
  --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
  --set config.kind="ControllerConfiguration" \
  --set config.enableGatewayAPI=true
```

Wait for cert-manager to be ready:

```
kubectl -n cert-manager rollout status deployment/cert-manager
kubectl -n cert-manager rollout status deployment/cert-manager-webhook
```

Verify Gateway API support is enabled by checking the logs:

```
kubectl -n cert-manager logs deployment/cert-manager --tail=20 | grep -i gateway
```

You should **not** see "skipping disabled controller" for gateway-shim.

**Note:** If cert-manager is already installed without Gateway API support, you can enable it with:

```
helm upgrade cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --reuse-values \
  --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
  --set config.kind="ControllerConfiguration" \
  --set config.enableGatewayAPI=true

kubectl -n cert-manager rollout restart deployment/cert-manager
```

**Step 2: Create a ClusterIssuer**

Create a ClusterIssuer that uses HTTP-01 challenges via your Gateway:

```
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: [email protected]
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        gatewayHTTPRoute:
          parentRefs:
          - name: my-test-gateway
            namespace: default
            kind: Gateway
```

Apply and verify:

```
kubectl apply -f clusterissuer.yaml
kubectl get clusterissuer letsencrypt-prod
```

**Step 3: Issue the certificate before adding HTTPS**

**Important:** There is a chicken-and-egg problem with Gateway API and cert-manager. If you add an HTTPS listener that references a Secret before cert-manager creates it, the Gateway reports `Invalid CertificateRef` and may stop routing all traffic, including HTTP. This prevents cert-manager's HTTP-01 challenge from completing.

To avoid this, issue the certificate while the Gateway is HTTP-only:

1. Create a Certificate resource that references your HTTP-only Gateway:

```
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: default
spec:
  secretName: app-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - app.example.com
```

2. Wait for the certificate to be issued:

```
kubectl get certificate app-tls -w
```

Once `READY` shows `True`, the Secret exists and you can proceed.

**Step 4: Add the HTTPS listener**

Now add the HTTPS listener to your Gateway:

```
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-test-gateway
  namespace: default
spec:
  gatewayClassName: cilium
  infrastructure:
    annotations:
      service.beta.kubernetes.io/upcloud-load-balancer-config: |
        {
          "frontends": [
            {
              "name": "port-443",
              "mode": "tcp",
              "port": 443
            }
          ]
        }
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: All
  - name: https
    protocol: HTTPS
    port: 443
    hostname: app.example.com
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: app-tls
    allowedRoutes:
      namespaces:
        from: All
```

**Step 5: Configure the Load Balancer for TLS passthrough**

By default, the UpCloud Load Balancer will auto-provision its own TLS certificate for port 443, which won't match your domain and will cause certificate errors.

To fix this, include the Load Balancer TCP mode configuration in your Gateway spec as shown in the [Customizing Load Balancer configuration](/docs/guides/gateway-api-migration#customizing-load-balancer-configuration-with-gateway-api.md) section above.

The complete Gateway spec with HTTPS listener and proper Load Balancer configuration is shown in Step 4.

### Certificate renewal

cert-manager will automatically renew certificates before they expire. However, because the HTTP-01 challenge requires HTTP traffic to work, ensure:

1. Your Gateway's HTTP listener remains active
2. The Load Balancer allows HTTP traffic on port 80

If you want to redirect HTTP to HTTPS, do so at the application level rather than removing the HTTP listener entirely.

## Cleanup

To remove the test Gateway and its associated Load Balancer:

```
kubectl delete gateway my-test-gateway
```

This deletes the Gateway, its underlying Service, and triggers deletion of the associated UpCloud Managed Load Balancer.

**Important**: If you delete your Kubernetes cluster without first deleting Gateway and Service objects, the Managed Load Balancers will not be automatically removed. You will need to delete them manually via the UpCloud Control Panel.

## Optional: Remove Ingress NGINX after migration

After you have validated traffic through Gateway API, remove the old Ingress objects and Ingress NGINX.

List Ingress objects and delete only the ones you have migrated:

```
kubectl get ingress -A
kubectl delete ingress <name> -n <namespace>
```

Remove ingress-nginx:

```
helm uninstall ingress-nginx -n ingress-nginx
```

Optional: remove the namespace:

```
kubectl delete namespace ingress-nginx
```

## Troubleshooting

**No external address after several minutes:**

First, find the Service created for your Gateway:

```
kubectl get svc -n <namespace> -l 'gateway.networking.k8s.io/gateway-name=<gateway-name>'
```

Then describe it to see events and load balancer provisioning status:

```
kubectl describe svc -n <namespace> -l 'gateway.networking.k8s.io/gateway-name=<gateway-name>'
```

Replace `<namespace>` with your Gateway's namespace (for example, `default`) and `<gateway-name>` with your Gateway's name (for example, `my-test-gateway`).

Check the UpCloud Hub under Load Balancers to verify provisioning status.

**Gateway stuck in Pending or NotProgrammed:**

```
kubectl describe gateway <gateway-name> -n <namespace>
```

Look at the Gateway conditions for Accepted and Programmed, and the reason message.

**HTTPRoute not attaching:**

```
kubectl get httproute <route-name> -n <namespace> -o yaml | grep -A 10 conditions
```

Look for Accepted and ResolvedRefs conditions and their reasons.

**TLSRoute not working:**

Install the experimental TLSRoute CRD.

**Gateway not programmed:**

Confirm `gatewayAPI.enabled=true` in `cilium-config`.

```
kubectl -n kube-system get configmap cilium-config -o yaml | grep -E "enable-gateway-api"
```

The value should be "true".

**HTTPS returns certificate error / wrong certificate:**

If you see a certificate for `lb-xxxx.upcloudlb.com` instead of your domain, the Load Balancer is terminating TLS instead of passing it through.

For new Gateways, use the `infrastructure.annotations` approach shown in [Customizing Load Balancer configuration](/docs/guides/gateway-api-migration#customizing-load-balancer-configuration-with-gateway-api.md).

For existing Gateways, you can fix this by annotating the Service:

```
kubectl annotate svc cilium-gateway-<gateway-name> \
  'service.beta.kubernetes.io/upcloud-load-balancer-config={"frontends":[{"name":"port-443","mode":"tcp","port":443}]}'
```

**Gateway shows "Invalid CertificateRef" and HTTP stops working:**

The HTTPS listener is referencing a Secret that doesn't exist. Either:

- Create the Secret manually, or
- Remove the HTTPS listener temporarily, issue the certificate using cert-manager, then re-add the HTTPS listener

**cert-manager not creating certificates for Gateway:**

Check if Gateway API support is enabled:

```
kubectl -n cert-manager logs deployment/cert-manager --tail=50 | grep -i gateway
```

If you see "skipping disabled controller" for gateway-shim, enable it:

```
helm upgrade cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --reuse-values \
  --set config.apiVersion="controller.config.cert-manager.io/v1alpha1" \
  --set config.kind="ControllerConfiguration" \
  --set config.enableGatewayAPI=true

kubectl -n cert-manager rollout restart deployment/cert-manager
```

**Cilium version not updating after upgrade:**

Only relevant if you have previously customised Cilium image tags or pinned versions.

If the upgrade command finishes but your Cilium pods remain on an older version, your existing Helm values may have pinned the image tags. The `--reuse-values` flag respects these pins, preventing the upgrade.

To fix this:

1. Check your values: `helm get values cilium -n kube-system -a > cilium_values_all.yaml`
2. Look for `image.tag` or `operator.image.tag`.
3. If found, re-run the upgrade command, adding `--set image.tag=v1.18.7 --set operator.image.tag=v1.18.7` (or whichever version matches your chart) to override the pin.
