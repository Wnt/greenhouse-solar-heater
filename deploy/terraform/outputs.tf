output "domain" {
  description = "Domain name for the server"
  value       = var.domain
}

output "s3_endpoint" {
  description = "S3-compatible endpoint URL for the credentials object storage"
  value       = "https://${[for e in upcloud_managed_object_storage.credentials.endpoint : e.domain_name if e.type == "public"][0]}"
}

output "s3_bucket" {
  description = "S3 bucket name for credentials"
  value       = upcloud_managed_object_storage_bucket.credentials.name
}

output "s3_access_key_id" {
  description = "S3 access key ID for the app"
  value       = upcloud_managed_object_storage_user_access_key.app.access_key_id
  sensitive   = true
}

output "s3_secret_access_key" {
  description = "S3 secret access key for the app"
  value       = upcloud_managed_object_storage_user_access_key.app.secret_access_key
  sensitive   = true
}

output "database_host" {
  description = "Managed PostgreSQL host"
  value       = upcloud_managed_database_postgresql.timeseries.service_host
}

output "database_port" {
  description = "Managed PostgreSQL port"
  value       = upcloud_managed_database_postgresql.timeseries.service_port
}

output "database_url" {
  description = "Full PostgreSQL connection URL"
  value       = upcloud_managed_database_postgresql.timeseries.service_uri
  sensitive   = true
}

# ── Kubernetes outputs ──

output "kubeconfig" {
  description = "Kubeconfig YAML for the UKS cluster — use with: terraform output -raw kubeconfig > ~/.kube/config"
  value       = data.upcloud_kubernetes_cluster.main.kubeconfig
  sensitive   = true
}

output "cluster_host" {
  description = "Kubernetes API server endpoint"
  value       = data.upcloud_kubernetes_cluster.main.host
}

output "cluster_name" {
  description = "UKS cluster name"
  value       = upcloud_kubernetes_cluster.main.name
}

output "worker_node_ip_command" {
  description = "Run this command to get the worker node's public IP for DNS"
  value       = "kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type==\"ExternalIP\")].address}'"
}

# ── CI/CD Deployer outputs ──

output "deployer_token" {
  description = "Long-lived token for the deployer ServiceAccount. Store as KUBE_TOKEN GitHub secret."
  value       = kubernetes_secret.deployer_token.data["token"]
  sensitive   = true
}

output "deployer_kubeconfig" {
  description = "Minimal kubeconfig for the deployer ServiceAccount. Store base64-encoded as KUBE_CONFIG_DATA GitHub secret."
  value = yamlencode({
    apiVersion = "v1"
    kind       = "Config"
    clusters = [{
      name = "uks"
      cluster = {
        server                     = data.upcloud_kubernetes_cluster.main.host
        certificate-authority-data = base64encode(data.upcloud_kubernetes_cluster.main.cluster_ca_certificate)
      }
    }]
    users = [{
      name = "deployer"
      user = {
        token = kubernetes_secret.deployer_token.data["token"]
      }
    }]
    contexts = [{
      name = "deployer"
      context = {
        cluster   = "uks"
        user      = "deployer"
        namespace = "default"
      }
    }]
    current-context = "deployer"
  })
  sensitive = true
}
