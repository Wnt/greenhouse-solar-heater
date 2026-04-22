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

variable "shelly_cloud_refresh_token" {
  description = "60-day refresh token for the Shelly Cloud REST API. Used by deploy + sensor-remap to keep the mobile/web app's device names in sync with the hardware role mapping. See scripts/rename-cloud-devices.mjs for how to obtain. Leave empty to skip cloud naming."
  type        = string
  sensitive   = true
  default     = ""
}

variable "shelly_cloud_api_url" {
  description = "Regional Shelly Cloud API shard URL, embedded in the access-token JWT's user_api_url claim but absent from the refresh token, so it must be stored alongside."
  type        = string
  default     = "https://shelly-249-eu.shelly.cloud"
}

# ── Kubernetes variables ──

variable "k8s_version" {
  description = "Kubernetes version for the UKS cluster (check UpCloud docs for versions supported by your plan)"
  type        = string
  default     = "1.34"
}

variable "node_plan" {
  description = "UpCloud server plan for Kubernetes worker nodes"
  type        = string
  default     = "DEV-1xCPU-2GB"
}

variable "node_count" {
  description = "Number of Kubernetes worker nodes"
  type        = number
  default     = 1
}

variable "control_plane_ip_filter" {
  description = "List of IP addresses/CIDRs allowed to access the Kubernetes API. Defaults to unrestricted. Restrict after cluster is working."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_public_key" {
  description = "SSH public key for worker node access (optional)"
  type        = string
  default     = ""
}

variable "vpn_allowed_cidrs" {
  description = "List of CIDRs allowed to connect to OpenVPN port 1194/UDP (e.g. your home network's public IP). Enforced via CiliumNetworkPolicy."
  type        = list(string)
}

variable "openvpn_config_file" {
  description = "Path to OpenVPN configuration file. Download from S3 with: node server/lib/vpn-config.js download openvpn.conf"
  type        = string
  default     = ""
}
