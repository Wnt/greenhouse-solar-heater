variable "domain" {
  description = "Domain name for the monitoring UI (e.g., greenhouse.madekivi.fi)"
  type        = string
}

variable "upcloud_zone" {
  description = "UpCloud zone for resource placement"
  type        = string
  default     = "fi-hel1"
}

variable "session_secret" {
  description = "HMAC secret for signed session cookies (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true
}

variable "objsto_region" {
  description = "UpCloud Managed Object Storage region"
  type        = string
  default     = "europe-1"
}

variable "github_repo" {
  description = "GitHub repository in owner/name format for GHCR image. Automatically lowercased for Docker compatibility."
  type        = string
}

variable "db_plan" {
  description = "UpCloud Managed PostgreSQL plan"
  type        = string
  default     = "1x1xCPU-1GB-10GB"
}

variable "new_relic_license_key" {
  description = "New Relic ingest license key (NRAK-...). Leave empty to disable observability."
  type        = string
  sensitive   = true
  default     = ""
}

# ── Kubernetes variables ──

variable "k8s_version" {
  description = "Kubernetes version for the UKS cluster"
  type        = string
  default     = "1.32"
}

variable "node_plan" {
  description = "UpCloud server plan for Kubernetes worker nodes"
  type        = string
  default     = "DEV-1xCPU-1GB-10GB"
}

variable "node_count" {
  description = "Number of Kubernetes worker nodes"
  type        = number
  default     = 1
}

variable "control_plane_ip_filter" {
  description = "List of IP addresses/CIDRs allowed to access the Kubernetes API (e.g. [\"1.2.3.4/32\"]). No default — must be set explicitly to avoid accidental public exposure."
  type        = list(string)
}

variable "ssh_public_key" {
  description = "SSH public key for worker node access (optional)"
  type        = string
  default     = ""
}

variable "openvpn_config" {
  description = "OpenVPN configuration file content. Populate after initial setup or pass from a file."
  type        = string
  sensitive   = true
  default     = ""
}
