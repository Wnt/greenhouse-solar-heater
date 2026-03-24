variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

variable "ssh_allow_ip" {
  description = "IP address allowed to SSH into the server. Leave empty to disable SSH access."
  type        = string
  default     = ""
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
  description = "Enable OpenVPN container and firewall rule (default: false)"
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
  description = "GitHub repository in owner/name format for GHCR image. Automatically lowercased for Docker compatibility."
  type        = string
}

variable "db_plan" {
  description = "UpCloud Managed PostgreSQL plan"
  type        = string
  default     = "1x1xCPU-1GB-10GB"
}

variable "new_relic_license_key" {
  description = "New Relic ingest license key (NRAK-...). Leave empty to disable observability. Enable with: terraform apply -var=\"new_relic_license_key=NRAK-...\""
  type        = string
  sensitive   = true
  default     = ""
}
