variable "ssh_public_key" {
  description = "SSH public key for root access to the server"
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
  default     = "1xCPU-2GB"
}
