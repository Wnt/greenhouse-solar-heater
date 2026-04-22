terraform {
  required_version = ">= 1.5"
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.1"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
  }
}

provider "upcloud" {
  # Credentials via UPCLOUD_TOKEN env var (token-based auth, see constitution V)
}

# ── Object Storage ──

resource "upcloud_managed_object_storage" "credentials" {
  name              = "${replace(var.domain, ".", "-")}-objsto"
  region            = var.objsto_region
  configured_status = "started"

  network {
    family = "IPv4"
    name   = "public"
    type   = "public"
  }
}

resource "upcloud_managed_object_storage_bucket" "credentials" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  name         = "credentials"
}

resource "upcloud_managed_object_storage_user" "app" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  username     = "app"
}

resource "upcloud_managed_object_storage_user_access_key" "app" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  username     = upcloud_managed_object_storage_user.app.username
  status       = "Active"
}

resource "upcloud_managed_object_storage_policy" "app_rw" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  name         = "app-credentials-rw"
  description  = "Read/write access to credentials bucket"
  document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::credentials", "arn:aws:s3:::credentials/*"]
    }]
  })
}

resource "upcloud_managed_object_storage_user_policy" "app_rw" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  username     = upcloud_managed_object_storage_user.app.username
  name         = upcloud_managed_object_storage_policy.app_rw.name
}

# ── Managed PostgreSQL with TimescaleDB ──

resource "upcloud_managed_database_postgresql" "timeseries" {
  name  = "${replace(var.domain, ".", "-")}-tsdb"
  plan  = var.db_plan
  title = "Greenhouse TimescaleDB"
  zone  = var.upcloud_zone

  properties {
    public_access = false
    timescaledb {
      max_background_workers = 4
    }
  }
}

# ── Store DATABASE_URL and CA certificate in S3 ──
# Fetches the per-account CA cert from the UpCloud API, then stores both
# the connection URL and CA cert in S3 using the db-config.js helper.
# Runs on the Terraform operator's machine (needs node + npm install + curl).
# Requires UPCLOUD_TOKEN env var (same as the Terraform provider).

resource "null_resource" "store_db_url" {
  triggers = {
    service_uri = upcloud_managed_database_postgresql.timeseries.service_uri
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../.."
    command     = <<-EOT
      curl -sf -H "Authorization: Bearer $UPCLOUD_TOKEN" \
        "https://api.upcloud.com/1.3/database/certificate" \
        | node -e "var d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{var c=JSON.parse(d).certificate;require('fs').writeFileSync('/tmp/db-ca-cert.pem',c)})" \
      && node server/lib/db-config.js store "${upcloud_managed_database_postgresql.timeseries.service_uri}" --ca /tmp/db-ca-cert.pem \
      && rm -f /tmp/db-ca-cert.pem
    EOT
    environment = {
      S3_ENDPOINT          = "https://${[for e in upcloud_managed_object_storage.credentials.endpoint : e.domain_name if e.type == "public"][0]}"
      S3_BUCKET            = upcloud_managed_object_storage_bucket.credentials.name
      S3_ACCESS_KEY_ID     = upcloud_managed_object_storage_user_access_key.app.access_key_id
      S3_SECRET_ACCESS_KEY = upcloud_managed_object_storage_user_access_key.app.secret_access_key
      S3_REGION            = var.objsto_region
    }
  }

  depends_on = [
    upcloud_managed_object_storage_user_policy.app_rw,
    upcloud_managed_database_postgresql.timeseries,
  ]
}

# ── Store New Relic license key in S3 ──
# Same S3 bootstrap pattern as DATABASE_URL (Constitution principle VII).

resource "null_resource" "store_nr_key" {
  count = var.new_relic_license_key != "" ? 1 : 0

  triggers = {
    license_key = var.new_relic_license_key
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../.."
    command     = "node server/lib/nr-config.js store \"${var.new_relic_license_key}\""
    environment = {
      S3_ENDPOINT          = "https://${[for e in upcloud_managed_object_storage.credentials.endpoint : e.domain_name if e.type == "public"][0]}"
      S3_BUCKET            = upcloud_managed_object_storage_bucket.credentials.name
      S3_ACCESS_KEY_ID     = upcloud_managed_object_storage_user_access_key.app.access_key_id
      S3_SECRET_ACCESS_KEY = upcloud_managed_object_storage_user_access_key.app.secret_access_key
      S3_REGION            = var.objsto_region
    }
  }

  depends_on = [
    upcloud_managed_object_storage_user_policy.app_rw,
  ]
}

# ── Kubernetes Cluster ──

resource "upcloud_network" "k8s" {
  name = "${replace(var.domain, ".", "-")}-k8s"
  zone = var.upcloud_zone

  ip_network {
    address = "172.16.1.0/24"
    dhcp    = true
    family  = "IPv4"
  }

  # UKS automatically attaches a router and network-peering routes to this
  # network for control-plane ↔ worker communication. Terraform must not
  # remove these computed attributes on subsequent applies.
  lifecycle {
    ignore_changes = [router, effective_routes, ip_network[0].dhcp_effective_routes]
  }
}

resource "upcloud_kubernetes_cluster" "main" {
  name                 = "${replace(var.domain, ".", "-")}-k8s"
  network              = upcloud_network.k8s.id
  zone                 = var.upcloud_zone
  plan                 = "dev-md"
  version              = var.k8s_version
  private_node_groups  = false
  control_plane_ip_filter = var.control_plane_ip_filter
}

resource "upcloud_kubernetes_node_group" "default" {
  cluster    = upcloud_kubernetes_cluster.main.id
  name       = "default"
  node_count = var.node_count
  plan       = var.node_plan

  ssh_keys = var.ssh_public_key != "" ? [var.ssh_public_key] : []
}

# ── Cluster Credentials ──
# The resource doesn't export credentials directly; use the data source.

data "upcloud_kubernetes_cluster" "main" {
  id = upcloud_kubernetes_cluster.main.id
}

# ── Kubernetes & Helm Providers ──
# Configured from cluster credentials to manage in-cluster resources.

provider "kubernetes" {
  host                   = data.upcloud_kubernetes_cluster.main.host
  client_certificate     = data.upcloud_kubernetes_cluster.main.client_certificate
  client_key             = data.upcloud_kubernetes_cluster.main.client_key
  cluster_ca_certificate = data.upcloud_kubernetes_cluster.main.cluster_ca_certificate
}

provider "helm" {
  kubernetes {
    host                   = data.upcloud_kubernetes_cluster.main.host
    client_certificate     = data.upcloud_kubernetes_cluster.main.client_certificate
    client_key             = data.upcloud_kubernetes_cluster.main.client_key
    cluster_ca_certificate = data.upcloud_kubernetes_cluster.main.cluster_ca_certificate
  }
}

# ── Ingress NGINX Controller ──
# Deployed as DaemonSet with hostNetwork: true so it binds to ports 80/443
# on the worker node's public IP. No managed load balancer needed.

resource "helm_release" "ingress_nginx" {
  name       = "ingress-nginx"
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  namespace  = "ingress-nginx"
  create_namespace = true
  version    = "4.12.0"

  set {
    name  = "controller.kind"
    value = "DaemonSet"
  }

  set {
    name  = "controller.hostNetwork"
    value = "true"
  }

  set {
    name  = "controller.service.type"
    value = "ClusterIP"
  }

  # Use host ports directly (80/443) — no NodePort mapping
  set {
    name  = "controller.dnsPolicy"
    value = "ClusterFirstWithHostNet"
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

# ── cert-manager ──
# Manages TLS certificates via Let's Encrypt HTTP-01 challenge.

resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  namespace  = "cert-manager"
  create_namespace = true
  version    = "v1.17.1"

  set {
    name  = "crds.enabled"
    value = "true"
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

# ── Let's Encrypt ClusterIssuer ──
# Deployed as a K8s manifest (deploy/k8s/cluster-issuer.yaml) via kubectl
# after terraform apply, because kubernetes_manifest requires an active
# cluster connection during plan which fails on first apply.

# ── Kubernetes Secrets ──

resource "kubernetes_secret" "app_secrets" {
  metadata {
    name = "app-secrets"
  }

  data = {
    DATABASE_URL         = upcloud_managed_database_postgresql.timeseries.service_uri
    SESSION_SECRET       = var.session_secret
    S3_ENDPOINT          = "https://${[for e in upcloud_managed_object_storage.credentials.endpoint : e.domain_name if e.type == "public"][0]}"
    S3_BUCKET            = upcloud_managed_object_storage_bucket.credentials.name
    S3_ACCESS_KEY_ID     = upcloud_managed_object_storage_user_access_key.app.access_key_id
    S3_SECRET_ACCESS_KEY = upcloud_managed_object_storage_user_access_key.app.secret_access_key
    S3_REGION            = var.objsto_region
    NEW_RELIC_LICENSE_KEY = var.new_relic_license_key
    SHELLY_CLOUD_REFRESH_TOKEN = var.shelly_cloud_refresh_token
    SHELLY_CLOUD_API_URL       = var.shelly_cloud_api_url
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

resource "kubernetes_secret" "openvpn_config" {
  metadata {
    name = "openvpn-config"
  }

  # Download VPN config from S3 first:
  #   S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  #     node server/lib/vpn-config.js download openvpn.conf
  # Then set openvpn_config_file = "openvpn.conf" in terraform.tfvars
  data = {
    "server.conf" = var.openvpn_config_file != "" ? file(var.openvpn_config_file) : ""
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

# ── Kubernetes ConfigMaps ──

resource "kubernetes_config_map" "app_config" {
  metadata {
    name = "app-config"
  }

  data = {
    PORT                        = "3000"
    AUTH_ENABLED                = "true"
    RPID                        = var.domain
    ORIGIN                      = "https://${var.domain}"
    DOMAIN                      = var.domain
    GITHUB_REPO                 = lower(var.github_repo)
    VPN_CHECK_HOST              = "192.168.30.20"
    VPN_CONFIG_KEY              = "openvpn.conf"
    SETUP_WINDOW_MINUTES        = "30"
    NODE_ENV                    = "production"
    MQTT_HOST                   = "localhost"
    SENSOR_HOST_IPS             = "192.168.30.20,192.168.30.21"
    OTEL_SERVICE_NAME           = "greenhouse-monitor"
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp.eu01.nr-data.net"
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

# ── OpenVPN Firewall ──
# IP whitelist for VPN port enforced via iptables in a pod init container.
# CiliumNetworkPolicy does NOT reliably filter hostPort traffic (bypasses CNI),
# so we use kernel-level iptables rules in the pod's network namespace instead.

resource "kubernetes_config_map" "vpn_firewall" {
  metadata {
    name = "vpn-firewall"
  }

  data = {
    VPN_ALLOWED_CIDRS = join(",", var.vpn_allowed_cidrs)
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

# ── CI/CD Deployer RBAC ──
# Minimal ServiceAccount that can only patch the "app" Deployment.
# The long-lived token is stored as a GitHub Actions secret (KUBE_TOKEN).

resource "kubernetes_service_account" "deployer" {
  metadata {
    name = "deployer"
    labels = {
      app = "greenhouse"
    }
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

resource "kubernetes_role" "deployer" {
  metadata {
    name = "deployer"
    labels = {
      app = "greenhouse"
    }
  }

  # Patch the app deployment (for kubectl set image)
  rule {
    api_groups     = ["apps"]
    resources      = ["deployments"]
    resource_names = ["app"]
    verbs          = ["get", "patch"]
  }

  rule {
    api_groups     = ["apps"]
    resources      = ["deployments"]
    resource_names = ["app"]
    verbs          = ["list", "watch"]
  }

  # Rollout status needs to watch ReplicaSets and Pods
  rule {
    api_groups = ["apps"]
    resources  = ["replicasets"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["get", "list", "watch"]
  }

  # kubectl exec into pods (for Shelly script deployment)
  rule {
    api_groups = [""]
    resources  = ["pods/exec"]
    verbs      = ["create"]
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

resource "kubernetes_role_binding" "deployer" {
  metadata {
    name = "deployer"
    labels = {
      app = "greenhouse"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role.deployer.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account.deployer.metadata[0].name
    namespace = "default"
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}

resource "kubernetes_secret" "deployer_token" {
  metadata {
    name = "deployer-token"
    labels = {
      app = "greenhouse"
    }
    annotations = {
      "kubernetes.io/service-account.name" = kubernetes_service_account.deployer.metadata[0].name
    }
  }

  type = "kubernetes.io/service-account-token"

  depends_on = [upcloud_kubernetes_node_group.default]
}

resource "kubernetes_config_map" "mosquitto_config" {
  metadata {
    name = "mosquitto-config"
  }

  data = {
    "mosquitto.conf" = <<-EOT
      listener 1883 0.0.0.0
      allow_anonymous true
    EOT
  }

  depends_on = [upcloud_kubernetes_node_group.default]
}
