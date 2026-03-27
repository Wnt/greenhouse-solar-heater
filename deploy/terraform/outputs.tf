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
  value       = upcloud_kubernetes_cluster.main.kubeconfig
  sensitive   = true
}

output "cluster_host" {
  description = "Kubernetes API server endpoint"
  value       = upcloud_kubernetes_cluster.main.host
}

output "cluster_name" {
  description = "UKS cluster name"
  value       = upcloud_kubernetes_cluster.main.name
}
