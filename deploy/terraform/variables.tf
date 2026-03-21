variable "ssh_public_key" {
  description = "SSH public key for server access (required by UpCloud cloud-init templates, but SSH port is not exposed)"
  type        = string
}

variable "domain" {
  description = "Domain name for the monitoring UI (e.g., greenhouse.madekivi.fi)"
  type        = string
}

variable "upcloud_zone" {
  description = "UpCloud zone for server placement"
  type        = string
  default     = "fi-hel1"
}

variable "server_plan" {
  description = "UpCloud server plan (CPU-RAM)"
  type        = string
  default     = "DEV-1xCPU-1GB-10GB"
}

variable "enable_vpn" {
  description = "Enable WireGuard VPN container and firewall rule (default: false)"
  type        = bool
  default     = false
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
  description = "GitHub repository in owner/name format for GHCR image (e.g., Wnt/greenhouse-solar-heater)"
  type        = string
}
